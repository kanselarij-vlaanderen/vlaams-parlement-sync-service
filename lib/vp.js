import { AGENDA_ITEM_TYPES, DOCUMENT_TYPES, DOMAIN, ENABLE_MOCK_INCOMING_FLOWS, SUBCASE_TYPES, VP_API_CLIENT_ID, VP_API_CLIENT_SECRET, VP_ERROR_EXPIRE_TIME } from '../config';
import fetch from 'node-fetch';
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
          `${DOMAIN}api/kaleidos/v1/status/kanselarij`
        );
        if (response.ok) {
          body = await response.json();
        } else {
          console.error(
            `Something went wrong while fetching incoming flows: ${response.status} ${response.statusText}`
          );
        }
      }
      const docs = this.verifyIncomingFlows(body.documenten);
      return this.transformIncomingFlows(docs);
    } catch (error) {
      console.trace(
        `Something went wrong while fetching incoming flows: ${error.message}`
      );
    }
  }

  /**
   * Verify that the incoming flows have the necessary files
   * Each "document" must have multiple "bestanden" (files):
   * - 1 verwijzingsfiche
   * - 1 PDF perkament
   * - 1 Word perkament
   * If any are missing, we remove the result before returning and log a warning
   *
   * @param {Object} responseBody
   * @returns {Object[]} Valid documents
   */
  verifyIncomingFlows(docs) {
    const validDocs = [];
    for (const doc of docs) {
      let hasPdf = false;
      let hasWord = false;
      let hasVerwijzingsfiche = false;
      for (const file of doc.bestanden) {
        const fileName = file.bestandsnaam;
        const extension = path.extname(fileName).slice(1);
        if (fileName.toLowerCase().includes('perkament')) {
          if (extension === 'pdf') {
            hasPdf = true;
          } else if (extension === 'docx') {
            hasWord = true;
          }
        } else if (fileName.toLowerCase().includes('verwijzingsfiche')) {
          if (extension === 'pdf') {
            hasVerwijzingsfiche = true;
          }
        }
      }
      if (hasPdf && hasWord && hasVerwijzingsfiche) {
        validDocs.push(doc);
      } else {
        console.warn(
          'Incoming VP case does not contain all expected files and will be ignored'
            + ` pobj: "${doc.pobj} hasPdf: ${hasPdf} hasWord: ${hasWord} hasVerwijzingsfiche: ${hasVerwijzingsfiche}"`
        );
      }
    }
    return validDocs;
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
      let documentType = null;
      let comment = '';

      if (doc.type.toLowerCase().includes("decreet")) {
        subcaseType = SUBCASE_TYPES.BEKRACHTIGING_VLAAMSE_REGERING;
        agendaItemType = AGENDA_ITEM_TYPES.NOTA;
        documentType = DOCUMENT_TYPES.DECREET;
      } else {
        subcaseType = SUBCASE_TYPES.DEFINITIEVE_GOEDKEURING;
        agendaItemType = AGENDA_ITEM_TYPES.MEDEDELING;
        if (doc.type.toLowerCase().includes("motie")) {
          documentType = DOCUMENT_TYPES.MOTIE;
        } else if (doc.type.toLowerCase().includes("RESOLUTIE")) {
          documentType = DOCUMENT_TYPES.RESOLUTIE;
        }
      }

      const document = {};
      const verwijzingsfiche = {};

      for (const file of doc.bestanden) {
        const pfls = file.pfls;
        const uri = file['kaleidos-id'] ?? undefined;
        const fileName = file.bestandsnaam;
        const extension = path.extname(fileName).slice(1);
        const base64 = file.base64;
        const mimeType = file.mimetype;

        if (fileName.toLowerCase().includes('perkament')) {
          if (extension === 'pdf') {
            if (file.opmerking) comment += `[PDF] ${file.opmerking}\n`;
            document.pdf = {
              pfls,
              uri,
              fileName,
              extension,
              mimeType,
              documentType,
              base64,
            };
          } else if (extension === 'docx') {
            if (file.opmerking) comment += `[Word] ${file.opmerking}\n`;
            document.word = {
              pfls,
              uri,
              fileName,
              extension,
              mimeType,
              documentType,
              base64,
            };
          }
        } else if (fileName.toLowerCase().includes('verwijzingsfiche')) {
          if (file.opmerking) comment += `[Verwijzingsfiche] ${file.opmerking}\n`;
          verwijzingsfiche.pdf = {
            pfls,
            uri,
            fileName,
            extension,
            mimeType,
            documentType: DOCUMENT_TYPES.VERWIJZINGSFICHE,
            base64,
          };
        }
      }

      transformedDocs.push({
        pobj,
        title,
        shortTitle,
        openingDate,
        themes,
        subcaseType,
        agendaItemType,
        comment,
        document,
        verwijzingsfiche,
      });
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

              "pfls": "xxxxx123",
              "kaleidos-id": "http://themis.vlaanderen.be/id/bestand/10077a30-d64f-11ee-aa90-877e487f50e6",
              "mimetype": "application/pdf",
              "bestandsnaam": "1746_Perkament.pdf",
              // "opmerking":"een typfoutje in het document",
              "base64": fs.readFileSync('/app/files/Open scholen decreet.pdf', { encoding: 'base64' }),
            }, {
              "pfls": "xx456",
              "kaleidos-id": "http://themis.vlaanderen.be/id/bestand/5f78a7c0-d64e-11ee-ad07-6d64f0bf2710",
              "mimetype": "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
              "bestandsnaam": "1746_Perkament.docx",
              // "opmerking": "",
              "base64": fs.readFileSync('/app/files/Open scholen decreet.pdf', { encoding: 'base64' }),
            }, {
              "pfls": "xx789",
              "kaleidos-id": "http://themis.vlaanderen.be/id/bestand/5f892280-d64e-11ee-ad07-6d64f0bf2710",
              "mimetype": "application/pdf",
              "bestandsnaam": "1746_Verwijzingsfiche.pdf",
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
