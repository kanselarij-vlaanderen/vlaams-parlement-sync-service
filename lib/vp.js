import fetch from 'node-fetch';
import {
  AGENDA_ITEM_TYPES,
  DOCUMENT_TYPES,
  DOMAIN,
  ENABLE_MOCK_SUBMITTED_FLOWS,
  ENABLE_MOCK_INCOMING_FLOWS,
  ENABLE_MOCK_VERWERKT_FILES,
  SUBCASE_TYPES,
  VP_API_CLIENT_ID,
  VP_API_CLIENT_SECRET,
  VP_ERROR_EXPIRE_TIME,
  VP_SHORTENED_EXPIRE_TIME,
  ENABLE_DEBUG_FILE_WRITING,
  ENABLE_SENDING_TO_VP_API,
  ENABLE_ALWAYS_CREATE_PARLIAMENT_FLOW,
  KALEIDOS_HOST_URL,
} from '../config';
import { encode } from "base-64";
import fs from 'fs';
import path from 'path';

import { getDecisionmakingFlowForAgendaitem } from "./agendaitem";
import {
  getPieceMetadata,
  filterRedundantFiles,
  getSubmittedPieces
} from "./piece";
import { getSubmitterForSubcase } from './subcase';
import {
  getDecisionmakingFlow,
  getLatestSubcase
} from "./decisionmaking-flow";

import {
  createOrUpdateParliamentFlow,
  enrichPiecesWithPreviousSubmissions,
} from "./parliament-flow";

import { createEmailOnSyncFailure } from './email';

class VP {
  constructor() {
    this.expireTime = 0;
  }

  /**
   * Adds the authorization header to the request
   * @param {string} url Url of the resource to fetch
   * @param {object} options
   * @returns {Promise<object>}
   * @throws
   */
  async fetchVp(url, options) {
    try {
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
    } catch (error) {
      console.log('getAccessToken failed in fetchVp');
      throw error;
    }
  }

  async initialize() {
    try {
      this.token = await this.getAccessToken();
      if (!this.token) {
        console.log('Silenced error -> token is empty in initialize');
      }
    } catch (error) {
      console.log('Silenced error -> getAccessToken failed in initialize');
    }
  }

  /**
   *
   * @returns access_token
   * @throws error if access token was not received
   */
  async getAccessToken() {
    try {
      if (!this.token || Date.now() > this.expireTime) {
        const newToken = await this.refreshAccessToken();
        if (newToken) {
          console.log('setting new token');
          // token can expire before sync actually happens so shortening it during setting
          this.token = newToken.access_token;
          this.expireTime = Date.now() + ((parseInt(newToken.expires_in) - VP_SHORTENED_EXPIRE_TIME ) * 1000);
        } else {
          throw new Error('No access token received from VP');
        }
      }
      // this must always be a valid token that is not expired
      return this.token;
    } catch (e) {
      console.log('setting error token');
      this.token = undefined;
      this.expireTime = Date.now() + (VP_ERROR_EXPIRE_TIME * 1000);
      throw e;
    }
  }

  /**
   *
   * @returns json response
   * @throws error if access token was not received
   */
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
        throw new Error(`Failed to retrieve access token for VP: ${response.status} ${response.statusText}`);
      }
    } catch (e) {
      console.trace(e.message);
      throw e;
    }
  }

  /* Pings the VP-API to make sure it is online and we can connect to it */
  async ping() {
    try {
      const response = await this.fetchVp(`${DOMAIN}api/kaleidos/v1/ping`, {
        method: 'GET'
      });
      return response;
    } catch (error) {
      console.log('Ping failed');
      return { error: { message: `Error during ping: ${error.message}` } };
    }
  }

  async sendDossier(dossier) {
    try {
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
    } catch (error) {
      console.log(`Silenced error -> Error sending dossier: ${error.message}`);
    }
  }

  /**
   * @param {string} parliamentId
   * @return {Promise<string>}
   */
  async getStatusForFlow(parliamentId) {
    try {
      const response = await this.fetchVp(
        `${DOMAIN}api/kaleidos/v1/status/${parliamentId}`
      );
      if (response.ok) {
        return await response.json();
      } else {
        console.log("Something went wrong while fetching the dossier status");
      }
    } catch (error) {
      console.log("Silenced error -> Something went wrong while fetching the dossier status");
    }
  }

  async createAndSendDossier(
    agendaitemUri,
    piecesUris,
    comment,
    user,
    isComplete
  ) {
    // Set default URI for debugging purposes.
    // Default URI points to https://kaleidos-test.vlaanderen.be/dossiers/6398392DC2B90D4571CF86EA/deeldossiers
    const decisionmakingFlowUri = await getDecisionmakingFlowForAgendaitem(
      agendaitemUri
    );

    if (!decisionmakingFlowUri) {
      throw new Error("Could not find decisionmaking flow for agendaitem");
    }

    const decisionmakingFlow = await getDecisionmakingFlow(
      decisionmakingFlowUri
    );

    if (!decisionmakingFlow) {
      throw new Error("Could not find decisionmaking flow");
    }

    const latestSubcase = await getLatestSubcase(decisionmakingFlowUri);

    if (!latestSubcase) {
      throw new Error("Could not find a subcase for decisionmaking flow");
    }

    const submitter = await getSubmitterForSubcase(latestSubcase.uri);

    let pieces = await getPieceMetadata(piecesUris);

    if (pieces.length === 0) {
      throw new Error("Could not find any files to send for decisionmaking flow")
    }

    const submitted = await getSubmittedPieces(piecesUris);
    pieces = filterRedundantFiles(pieces, submitted);

    if (decisionmakingFlow.parliamentFlow) {
      pieces = await enrichPiecesWithPreviousSubmissions(
        decisionmakingFlow.parliamentFlow,
        pieces
      );
    }

    if (ENABLE_DEBUG_FILE_WRITING) {
      fs.writeFileSync("/debug/pieces.json", JSON.stringify(pieces, null, 2));
    }

    let payload;
    let contact = {
      name: `${user.firstName} ${user.familyName}`,
      email: user.mbox? user.mbox.replace('mailto:', '') : ''
    };
    try {
      payload = this.generatePayload(
        decisionmakingFlow,
        pieces,
        comment,
        contact,
        latestSubcase,
        submitter
      );
    } catch (error) {
      throw new Error(`An error occurred while creating the payload: "${error.message}"`)
    }

    // For debugging
    if (ENABLE_DEBUG_FILE_WRITING) {
      fs.writeFileSync("/debug/payload.json", JSON.stringify(payload, null, 2));
    }
    if (ENABLE_SENDING_TO_VP_API) {
      let response;
      try {
        response = await this.sendDossier(payload);
      } catch (error) {
        console.log(error.message);
        throw new Error(`Error while sending to VP: ${error.message}`);
      }

      if (response.ok) {
        const responseJson = await response.json();
        if (ENABLE_DEBUG_FILE_WRITING) {
          fs.writeFileSync(
            "/debug/response.json",
            JSON.stringify(responseJson, null, 2)
          );
        }
        await createOrUpdateParliamentFlow(
          responseJson,
          decisionmakingFlowUri,
          pieces,
          latestSubcase.title,
          user.uri,
          comment,
          isComplete
        );
      } else {
        if (ENABLE_DEBUG_FILE_WRITING) {
          fs.writeFileSync(
            "/debug/response.json",
            JSON.stringify(response, null, 2)
          );
        }
        let errorMessage = `VP API responded with status ${response.status} and the following message: "${response.statusText}"`;
        if (response.error && response.error.message) {
          errorMessage = response.error.message;
        }
        throw new Error(errorMessage);
      }
    } else {
      if (ENABLE_ALWAYS_CREATE_PARLIAMENT_FLOW) {
        let allFiles = [];
        for (const piece of pieces) {
          for (const file of piece.files) {
            allFiles.push({
              id: file.uri,
              pfls: "" + Math.floor(1000 + Math.random() * 9000), // random 4-digit pobj
            });
          }
        }
        let mockResponseJson = {
          MOCKED: true,
          status: "SUCCESS",
          id: decisionmakingFlowUri,
          pobj: "" + Math.floor(100 + Math.random() * 900), // random 3-digit pobj
          files: allFiles,
        };
        if (ENABLE_DEBUG_FILE_WRITING) {
          fs.writeFileSync(
            "/debug/response.json",
            JSON.stringify(mockResponseJson, null, 2)
          );
        }
        await createOrUpdateParliamentFlow(
          mockResponseJson,
          decisionmakingFlowUri,
          pieces,
          latestSubcase.title,
          user.uri,
          comment,
          isComplete
        );
      }
    }
  }

  /**
   * @param {DecisionmakingFlow} decisionmakingFlow
   * @param {Pieces[]} pieces
   * @param {?string} comment
   */
  generatePayload(
    decisionmakingFlow,
    pieces,
    comment = undefined,
    contact,
    subcase,
    submitter
  ) {
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
      indiener: submitter ? {
        titel: submitter.title,
        naam: submitter.lastName,
        voornaam: submitter.firstName,
      } : null,
      contact,
      '@id': decisionmakingFlow.uri,
      '@type': 'Besluitvormingsaangelegenheid',
      'Besluitvormingsaangelegenheid.naam': decisionmakingFlow.name,
      'Besluitvormingsaangelegenheid.alternatieveNaam': subcase.title,
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

  /**
   *
   * @param {*} days
   * @returns
   * @throws error on failure to get data
   */
  async fetchSubmittedFlows(days) {
    if (ENABLE_MOCK_SUBMITTED_FLOWS) {
      return [
        {
          "pobj": 1234,
          "status": "ingediend",
          "datum": "2024-03-28T10:26:00.000000Z"
        },
        {
          "pobj": 9876,
          "pobj_vorig": 5678,
          "status": "ingediend",
          "datum": "2024-04-20T14:50:00.000000Z"
        },
        {
          "pobj": 8765,
          "status": "niet ingeschreven",
          "datum": "2024-09-09T14:50:00.000000Z"
        }
      ];
    } else {
      let response;
      try {
        response = await this.fetchVp(
          `${DOMAIN}api/kaleidos/v1/status/ingediend${
            days ? `?dagen=${days}`: ''
          }`
        );
        if (response.ok) {
          const data = await response.json();
          return data.documenten;
        } else {
          throw new Error(`fetching submitted flows failed with invalid response: ${response.status} ${response.statusText}`);
        }
      } catch (error) {
        console.error(
          `Something went wrong while fetching submitted flows: ${error.message}`
        );
        throw error;
      }
    }
  }

  /**
   *
   * @param {*} debug
   * @param {*} transformOnDebug
   * @returns
   * @throws error on failure to get data
   */
  async fetchIncomingFlows(debug, transformOnDebug) {
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
          if (debug) {
            if (transformOnDebug) {
              return await this.transformIncomingFlows(body.documenten);
            }
            return await body;
          }
        } else {
          throw new Error(`fetching incoming flows failed with invalid response: ${response.status} ${response.statusText}`);
        }
      }
      return await this.transformIncomingFlows(body.documenten);
    } catch (error) {
      console.trace(
        `Something went wrong while fetching incoming flows: ${error.message}`
      );
      throw error;
    }
  }

  async notifyReceivedDocument(payload, shouldThrowOnError = false) {
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
        body: JSON.stringify(payload),
      });
      if (response.ok) {
        const body = await response.json();
        console.debug('Notification to VP about recieved document returned response:', JSON.stringify(body, null, 2));
        console.log('Notification about received documents successfully sent.');
      } else {
        console.log(`Error in response when notifying VP about received documents: ${response.status} ${response.statusText}`);
        console.log(response);
        throw new Error('Error in response when notifying VP');
      }
    } catch (error) {
      console.trace(`Silenced error -> Something went wrong while notifying VP about received documents: ${error.message}`);
      await createEmailOnSyncFailure(
        "VP partial FAILURE: We could not notify VP of received documents, a manual intervention may be needed.",
        `environment: ${KALEIDOS_HOST_URL}
        
  detail of error: ${error?.message || "no details available"}`
      );
      if (shouldThrowOnError) {
        throw error;
      }
    }
  }

  generateNotificationPayload(decisionmakingFlow, pieces) {
    const piecesPart = pieces ? {
      'Dossier.bestaatUit': pieces.map((piece) => ({
        '@id': piece.uri,
        'Stuk.isVoorgesteldDoor': piece.files.map((file) => ({
          pfls: file.pfls,
          '@id': file.uri,
        })),
      })),
    } : {
      'Dossier.bestaatUit': []
    };

    return {
      pobj: decisionmakingFlow.pobj,
      '@id': decisionmakingFlow.uri,
      '@reverse': {
        'Dossier.isNeerslagVan': {
          '@id': decisionmakingFlow.case,
          '@type': 'Dossier',
          ...piecesPart,
        }
      }
    }
  }

  async transformIncomingFlows(docs) {
    const transformedDocs = [];
    for (const doc of docs) {
      const pobj = doc.pobj;
      const uri = doc["kaleidos-id"];
      // The 'onderwerp' field typically contains something along he lines of
      // "{Decreet,Motie,Resolutie} tot ..." which would generally be a long
      // title. But the VP doesn't currently seem to send a 'citeertitel',
      // which is what we would put in the short title.
      // Since the short title is our main title for cases and subcases, we
      // choose to use the 'onderwerp' as the short title, and leave the
      // long title empty.
      // The 'titel' field seems to be the 'onderwerp' field prefixed with the
      // string 'Perkament. '. 🤷
      const title = undefined;
      let shortTitle = doc.onderwerp ?? doc.titel ?? undefined;
      const authorityDomain = doc.bevoegdheidsdomein;
      const themes = doc.themas;

      let openingDate;
      if (ENABLE_MOCK_INCOMING_FLOWS) {
        // don't attempt to get status when mocking
        openingDate = new Date();
      } else {
        let statusesObject = await this.getStatusForFlow(pobj);
        const status = statusesObject?.statussen?.find((status) => status.status === "aangenomen in plenaire vergadering");
        if (status && status.datum) {
          openingDate = new Date(status.datum);
        } else {
          throw new Error(pobj + " is niet aangenomen in plenaire vergadering");
        }
      }

      let shortTitlePrefix = '';
      let subcaseType = SUBCASE_TYPES.DEFINITIEVE_GOEDKEURING;
      let agendaItemType = AGENDA_ITEM_TYPES.MEDEDELING;

      const documentTypeMapping = {
        'perkament decreet': DOCUMENT_TYPES.DECREET,
        'perkament resolutie': DOCUMENT_TYPES.RESOLUTIE,
        'perkament motie': DOCUMENT_TYPES.MOTIE,
        'verwijzingsblad': DOCUMENT_TYPES.VERWIJZINGSFICHE,
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
        const comment = file.opmerking ? `[${file.type} (${extension})] ${file.opmerking}` : '';

        if (documentType === DOCUMENT_TYPES.DECREET) {
          subcaseType = SUBCASE_TYPES.BEKRACHTIGING_VLAAMSE_REGERING;
          agendaItemType = AGENDA_ITEM_TYPES.NOTA;
        }

        if (!shortTitlePrefix) {
          switch (documentType) {
            case DOCUMENT_TYPES.DECREET:
              shortTitlePrefix = "Bekrachtiging en afkondiging van het decreet ";
              break;
            case DOCUMENT_TYPES.RESOLUTIE:
              shortTitlePrefix = "Resolutie ";
              break;
            case DOCUMENT_TYPES.MOTIE:
              shortTitlePrefix = "Motie ";
              break;
            default:
              break;
          }
          if (shortTitlePrefix) {
            if (shortTitle) {
              shortTitle = shortTitlePrefix + shortTitle[0].toLowerCase() + shortTitle.slice(1);
            } else {
              shortTitle = shortTitlePrefix;
            }
            const dateOptions = {
              year: 'numeric',
              month: 'long',
              day: 'numeric',
            };
            const dateSuffix = openingDate.toLocaleDateString('nl-BE', dateOptions);
            shortTitle += ", aangenomen door het Vlaams Parlement op " + dateSuffix;
          }
        }
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
            comment,
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
              comment,
            }],
          });
        }
      }

      if (files.length) {
        transformedDocs.push({
          pobj,
          uri,
          title,
          shortTitle,
          openingDate,
          authorityDomain,
          themes,
          subcaseType,
          agendaItemType,
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
          // "kaleidos-id": "http://themis.vlaanderen.be/id/besluitvormingsaangelegenheid/ID-HERE",
          "type": "Ontwerp van decreet",
          "onderwerp": "over open scholen",
          "titel": "Ontwerp van decreet over open scholen",
          "citeertitel": "Open scholen",
          "datum": "2024-03-07T10:00:00Z",
          "bevoegdheidsdomein": "Onderwijs",
          "themas": ["Onderwijs en Vorming", "Media"],
          // "kanselarij" : "2024-02-22T10:00:00Z", /* wanneer naar ons verstuurd */
          // "verwerkt": "2024-02-22T11:00:00Z", /* wanneer door ons verwerkt */
          "bevoegdheid": "gewest", // of "gemeenschap" of "gewest en gemeenschap"
          "bestanden": [
            {
              // "pfls": "1",
              "pfls": "11",
              // "kaleidos-id": "http://themis.vlaanderen.be/id/bestand/fafc0b70-d733-11ee-9051-93d5d90b09ac",
              "type": "Perkament decreet",
              "mimetype": "application/pdf",
              "bestandsnaam": "1746_Perkament.pdf",
              "opmerking": "een typfoutje in het document",
              // "base64": fs.readFileSync('/app/files/Open scholen decreet.pdf', { encoding: 'base64' }),
              "base64": fs.readFileSync('/app/files/Open scholen decreet.pdf', { encoding: 'base64' }),
            }, {
              "pfls": "2",
              // "kaleidos-id": "http://themis.vlaanderen.be/id/bestand/",
              "type": "Perkament decreet",
              "mimetype": "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
              "bestandsnaam": "1746_Perkament.docx",
              "opmerking": "Deze word is scheef gescand",
              "base64": fs.readFileSync('/app/files/Open scholen decreet.docx', { encoding: 'base64' }),
            }, {
              "pfls": "3",
              // "kaleidos-id": "http://themis.vlaanderen.be/id/bestand/",
              "type": "Bijlage",
              "mimetype": "application/pdf",
              "bestandsnaam": "Bijlage1.pdf",
              // "opmerking": "",
              "base64": fs.readFileSync('/app/files/ander test bestand.pdf', { encoding: 'base64' }),
            }, {
              "pfls": "4",
              // "kaleidos-id": "http://themis.vlaanderen.be/id/bestand/",
              "type": "Bijlage",
              "mimetype": "application/pdf",
              "bestandsnaam": "Bijlage2.pdf",
              // "opmerking": "",
              "base64": fs.readFileSync('/app/files/ander test bestand.pdf', { encoding: 'base64' }),
            }, {
              "pfls": "5",
              // "kaleidos-id": "http://themis.vlaanderen.be/id/bestand/",
              "type": "Verwijzingsblad",
              "mimetype": "application/pdf",
              "bestandsnaam": "1746_Verwijzingsfiche.pdf",
              "opmerking": "Dit document is ter vervanging van het vorige",
              "base64": fs.readFileSync('/app/files/ander test bestand.pdf', { encoding: 'base64' }),
            },
          ]
        }
      ]
    };
  }
}

export default new VP();
