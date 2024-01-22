import {
  DOMAIN,
  VP_API_CLIENT_ID,
  VP_API_CLIENT_SECRET,
  VP_ERROR_EXPIRE_TIME,
} from "../config";
import fetch from "node-fetch";
import { encode } from "base-64";
import fs from "fs";
import { getDecisionmakingFlowForAgendaitem } from "./agendaitem";
import { getPieceMetadata } from "./piece";
import { getDecisionmakingFlow } from "./decisionmaking-flow";
import {
  ENABLE_DEBUG_FILE_WRITING,
  ENABLE_SENDING_TO_VP_API,
  ENABLE_ALWAYS_CREATE_PARLIAMENT_FLOW,
} from "../config";

import {
  createOrUpdateParliamentFlow,
  enrichPiecesWithPreviousSubmissions,
} from "./parliament-flow";

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

  async createAndsendDossier(
    agendaitemUri,
    piecesUris,
    comment,
    submitterUri,
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

    let pieces = await getPieceMetadata(piecesUris);

    if (pieces.length === 0) {
      throw new Error("Could not find any files to send for decisionmaking flow")
    }

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
    try {
      payload = this.generatePayload(decisionmakingFlow, pieces, comment);
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
          submitterUri,
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
        throw new Error(errorMessage)
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
          submitterUri,
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
  generatePayload(decisionmakingFlow, pieces, comment=undefined) {
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
}

export default new VP();
