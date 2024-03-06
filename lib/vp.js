import fetch from 'node-fetch';
import { AGENDA_ITEM_TYPES, DOCUMENT_TYPES, DOMAIN, ENABLE_MOCK_INCOMING_FLOWS, ENABLE_MOCK_VERWERKT_FILES, SUBCASE_TYPES, VP_API_CLIENT_ID, VP_API_CLIENT_SECRET, VP_ERROR_EXPIRE_TIME } from '../config';
import { encode } from "base-64";
import fs from 'fs';
import path from 'path';

class VP {
  constructor() {
    this.expireTime = 0;
  }

  /**
   * Adds the authorization header to the request
   * @param {string} url Url of the resource to fetch
   * @param {object} options
   * @returns {Promise<object>}
   */
  async fetchVp(url, options) {
    const accessToken = await this.getAccessToken();
    if (!accessToken) {
      return { error: { message: 'Error getting accessToken' } };
    }
    const authorizedOptions = {
      ...options,
      headers: {
        ...options?.headers,
        'Authorization': `Bearer ${accessToken}`
      }
    }
    return await fetch(url, authorizedOptions);
  }

  async initialize() {
    this.token = await this.getAccessToken()
  }

  async getAccessToken() {
    if (Date.now() > this.expireTime) {
      const newToken = await this.refreshAccessToken();
      if (newToken) {
        this.token = newToken.access_token;
        this.expireTime = Date.now() + (parseInt(newToken.expires_in) * 1000);
      } else {
        this.token = undefined;
        this.expireTime = Date.now() + (VP_ERROR_EXPIRE_TIME * 1000);
      }
    }

    return this.token;
  }

  async refreshAccessToken() {
    console.log("Requesting new access token...");
    const oauth2 = encode(VP_API_CLIENT_ID + ":" + VP_API_CLIENT_SECRET);
    try {
      const response = await fetch(`${DOMAIN}api/kaleidos/oauth/token`, {
        method: 'POST',
        headers: {
          'Authorization': 'Basic ' + oauth2,
          'Content-Type': 'application/x-www-form-urlencoded',
        },
        body: 'grant_type=client_credentials'
      });

      if (response.ok) {
        console.log(`Access token successfully retrieved.`);
        return await response.json();
      } else {
        console.log(`Failed to retrieve access token for VP: ${response.status} ${response.statusText}`);
      }
    } catch (e) {
      console.log(e);
    }
  }

  /* Pings the VP-API to make sure it is online and we can connect to it */
  async ping() {
    const response = await this.fetchVp(`${DOMAIN}api/kaleidos/v1/ping`, {
      method: 'GET'
    });
    return response;
  }

  async sendDossier(dossier) {
    const response = await this.fetchVp(`${DOMAIN}api/kaleidos/v1/document`, {
      method: 'POST',
      body: JSON.stringify(dossier)
    });
    if (response.ok) {
      console.log(`Dossier successfully sent.`);
    } else {
      console.log(`Error sending dossier: ${response.status} ${response.statusText}`);
      console.log(response);
    }

    return response;
  }

  /**
   * @param {string} parliamentId
   * @return {Promise<string>}
   */
  async getStatusForFlow(parliamentId) {
    const response = await this.fetchVp(
      `${DOMAIN}api/kaleidos/v1/status/${parliamentId}`
    );
    if (response.ok) {
      return await response.json();
    } else {
      console.log("Something went wrong while fetching the dossier status");
    }
  }

  /**
   * @param {DecisionmakingFlow} decisionmakingFlow
   * @param {Pieces[]} pieces
   * @param {?string} comment
   */
  generatePayload(decisionmakingFlow, pieces, comment=undefined, contact) {
    const pobj = decisionmakingFlow.pobj;
    const payload = {
      '@context': [
        'https://data.vlaanderen.be/doc/applicatieprofiel/besluitvorming/erkendestandaard/2021-02-04/context/besluitvorming-ap.jsonld',
        {
          'Stuk.isVoorgesteldDoor': 'https://data.vlaanderen.be/ns/dossier#isVoorgesteldDoor',
          'Concept': 'http://www.w3.org/2004/02/skos/core#Concept',
          'format': 'http://purl.org/dc/terms/format',
          'content': 'http://www.w3.org/ns/prov#value',
          'prefLabel': 'http://www.w3.org/2004/02/skos/core#prefLabel',
          'filename': 'http://www.semanticdesktop.org/ontologies/2007/03/22/nfo#fileName',
        }
      ],
      pobj,
      comment,
      contact,
      '@id': decisionmakingFlow.uri,
      '@type': 'Besluitvormingsaangelegenheid',
      'Besluitvormingsaangelegenheid.naam': decisionmakingFlow.name,
      'Besluitvormingsaangelegenheid.alternatieveNaam': decisionmakingFlow.altName,
      'Besluitvormingsaangelegenheid.beleidsveld': decisionmakingFlow.governmentFields.map(
        (field) => ({
          '@id': field.uri,
          '@type': 'Concept',
          prefLabel: field.label,
        })
      ),
      '@reverse': {
        'Dossier.isNeerslagVan': {
          '@id': decisionmakingFlow.case,
          '@type': 'Dossier',
          'Dossier.bestaatUit': pieces.map(
            (piece) => ({
              '@id': piece.uri,
              '@type': 'Stuk',
              'Stuk.naam': piece.name,
              'Stuk.creatiedatum': piece.created.toISOString(),
              'Stuk.type': {
                '@id': piece.type.uri,
                '@type': 'Concept',
                prefLabel: piece.type.label,
              },
              'Stuk.isVoorgesteldDoor': piece
                .files
                .filter((file) => fs.existsSync(file.shareUri.replace('share://', '/share/')))
                .map((file) => {
                const content = fs.readFileSync(
                  file.shareUri.replace('share://', '/share/'),
                  { encoding: 'base64' }
                );
                let filename = piece.name;
                if (file.isSigned) {
                  filename += ' (ondertekend)';
                }
                filename += `.${file.extension}`;
                const previousId = file.previousVersionUri;
                const previousPfls = file.previousVersionParliamentId;
                return {
                  '@id': file.uri,
                  '@type': 'http://www.w3.org/ns/dcat#Distribution',
                  format: file.format,
                  filename: filename,
                  signed: file.isSigned,
                  previousId,
                  previousPfls,
                  content,
                }
              })
            })
          ),
        }
      }
    };
    return payload;
  }

  async fetchSubmittedFlows() {
    let response;
    try {
      response = await this.fetchVp(
        `${DOMAIN}api/kaleidos/v1/status/ingediend`
      );
      if (response.ok) {
        const data = await response.json();
        return data.documenten;
      } else {
        console.error(
          `Something went wrong while fetching submitted flows: ${response.status} ${response.statusText}`
        );
      }
    } catch (error) {
      console.error(
        `Something went wrong while fetching submitted flows: ${error.message}`
      );
    }
  }

  async fetchIncomingFlows() {
    try {
      let body;
      if (ENABLE_MOCK_INCOMING_FLOWS) {
        body = this.mockedIncomingFlows();
      } else {
        const response = await this.fetchVp(
          `${DOMAIN}api/kaleidos/v1/kanselarij`
        );
        if (response.ok) {
          body = await response.json();
        } else {
          console.error(
            `Something went wrong while fetching incoming flows: ${response.status} ${response.statusText}`
          );
        }
      }
      return this.transformIncomingFlows(body.documenten);
    } catch (error) {
      console.trace(
        `Something went wrong while fetching incoming flows: ${error.message}`
      );
    }
  }

  async notifyReceivedDocument(payload) {
    console.debug(ENABLE_MOCK_VERWERKT_FILES
                  ? 'MOCKING ENABLED, not notifying VP about received document, but would have sent this payload:'
                  : 'Going to notify VP about received document with payload:',
                  JSON.stringify(payload, null, 2));
    if (ENABLE_MOCK_VERWERKT_FILES) {
      return;
    }
    let response;
    try {
      response = await this.fetchVp(`${DOMAIN}api/kaleidos/v1/verwerkt`, {
        method: 'POST',
        body: json.stringify(payload),
      });
      if (response.ok) {
        const body = await response.json();
        console.debug('Notification to VP about recieved document returned response:', JSON.stringify(body, null, 2));
        console.log('Notification about received documents successfully sent.');
      } else {
        console.log(`Error notifying VP about received documents: ${response.status} ${response.statusText}`);
        console.log(response);
      }
    } catch (error) {
      console.trace(`Something went wrong while notifying VP about received documents: ${error.message}`);
    }
  }

  generateNotificationPayload(decisionmakingFlow, pieces) {
    return {
      pobj: decisionmakingFlow.pobj,
      '@id': decisionmakingFlow.uri,
      '@reverse': {
        'Dossier.isNeerslagVan': {
          '@id': decisionmakingFlow.case,
          '@type': 'Dossier',
          'Dossier.bestaatUit': pieces.map((piece) => ({
            '@id': piece.uri,
            'Stuk.isVoorgesteldDoor': piece.files.map((file) => ({
              pfls: file.pfls,
              '@id': file.uri,
            })),
          })),
        }
      }
    }
  }

  transformIncomingFlows(docs) {
    const transformedDocs = [];
    for (const doc of docs) {
      const pobj = doc.pobj;
      const title = doc.titel ?? doc.citeertitel ?? undefined;
      const shortTitle = doc.citeertitel ?? undefined;
      const themes = doc.themas;
      const openingDate = doc.datum ? new Date(doc.datum) : new Date();

      let subcaseType = null;
      let agendaItemType = null;
      let comment = '';

      if (doc.type.toLowerCase().includes("decreet")) {
        subcaseType = SUBCASE_TYPES.BEKRACHTIGING_VLAAMSE_REGERING;
        agendaItemType = AGENDA_ITEM_TYPES.NOTA;
      } else {
        subcaseType = SUBCASE_TYPES.DEFINITIEVE_GOEDKEURING;
        agendaItemType = AGENDA_ITEM_TYPES.MEDEDELING;
      }

      const documentTypeMapping = {
        'decreet': DOCUMENT_TYPES.DECREET,
        'verwijzingsfiche': DOCUMENT_TYPES.VERWIJZINGSFICHE,
        'bijlage': DOCUMENT_TYPES.BIJLAGE,
      };
      const files = [];

      for (const file of doc.bestanden) {
        const base64 = file.base64;
        if (!base64) continue;

        const pfls = file.pfls;
        const uri = file['kaleidos-id'] ?? undefined;
        const fileName = file.bestandsnaam;
        const extension = path.extname(fileName).slice(1);
        const fileNameWithoutExtension = path.parse(fileName).name;
        const mimeType = file.mimetype;
        const documentType = documentTypeMapping[file.type.toLowerCase()];
        if (file.opmerking) comment += `[${file.type}] ${file.opmerking}\n`;

        // Check if current file is another version of other file
        const otherFileWithSameName = files.find(
          (f) => f.fileNameWithoutExtension === fileNameWithoutExtension
        );
        if (otherFileWithSameName) {
          otherFileWithSameName.representations.push({
            pfls,
            uri,
            fileName,
            extension,
            mimeType,
            base64,
          });
        } else {
          files.push({
            fileNameWithoutExtension,
            documentType,
            representations: [{
              pfls,
              uri,
              fileName,
              extension,
              mimeType,
              base64,
            }],
          });
        }
      }

      if (files.length) {
        transformedDocs.push({
          pobj,
          title,
          shortTitle,
          openingDate,
          themes,
          subcaseType,
          agendaItemType,
          comment,
          files,
        });
      }
    }
    return transformedDocs;
  }

  mockedIncomingFlows() {
    return {
      "documenten": [
        {
          "pobj": "1234",
          // "kaleidos-id": "",
          "type": "Ontwerp van decreet",
          "onderwerp": "over open scholen",
          "titel": "Ontwerp van decreet over open scholen",
          "citeertitel": "Open scholen",
          "datum": "2024-02-22T10:00:00Z",
          "bevoegdheidsdomein": "Onderwijs",
          "themas": ["Onderwijs en Vorming"],
          // "kanselarij" : "2024-02-22T10:00:00Z", /* wanneer naar ons verstuurd */
          // "verwerkt": "2024-02-22T11:00:00Z", /* wanneer door ons verwerkt */
          "bevoegdheid": "gewest", // of "gemeenschap" of "gewest en gemeenschap"
          "bestanden": [
            {
              // "pfls": "1",
              "pfls": "11",
              "kaleidos-id": "http://themis.vlaanderen.be/id/bestand/fafc0b70-d733-11ee-9051-93d5d90b09ac",
              "type": "Decreet",
              "mimetype": "application/pdf",
              "bestandsnaam": "1746_Perkament.pdf",
              // "opmerking":"een typfoutje in het document",
              // "base64": fs.readFileSync('/app/files/Open scholen decreet.pdf', { encoding: 'base64' }),
              "base64": fs.readFileSync('/app/files/ander test bestand.pdf', { encoding: 'base64' }),
            }, {
              "pfls": "2",
              // "kaleidos-id": "http://themis.vlaanderen.be/id/bestand/",
              "type": "Decreet",
              "mimetype": "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
              "bestandsnaam": "1746_Perkament.docx",
              // "opmerking": "",
              "base64": fs.readFileSync('/app/files/Open scholen decreet.pdf', { encoding: 'base64' }),
            }, {
              "pfls": "3",
              // "kaleidos-id": "http://themis.vlaanderen.be/id/bestand/",
              "type": "Verwijzingsfiche",
              "mimetype": "application/pdf",
              "bestandsnaam": "1746_Verwijzingsfiche.pdf",
              // "opmerking": "",
              "base64": fs.readFileSync('/app/files/Open scholen decreet.pdf', { encoding: 'base64' }),
            }, {
              "pfls": "4",
              // "kaleidos-id": "http://themis.vlaanderen.be/id/bestand/",
              "type": "Bijlage",
              "mimetype": "application/pdf",
              "bestandsnaam": "Bijlage1.pdf",
              // "opmerking": "",
              "base64": fs.readFileSync('/app/files/Open scholen decreet.pdf', { encoding: 'base64' }),
            }, {
              "pfls": "5",
              // "kaleidos-id": "http://themis.vlaanderen.be/id/bestand/",
              "type": "Bijlage",
              "mimetype": "application/pdf",
              "bestandsnaam": "Bijlage2.pdf",
              // "opmerking": "",
              "base64": fs.readFileSync('/app/files/Open scholen decreet.pdf', { encoding: 'base64' }),
            }
          ]
        }
      ]
    };
  }
}

export default new VP();
