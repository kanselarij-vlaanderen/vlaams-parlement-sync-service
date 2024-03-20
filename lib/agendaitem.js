import { query, sparqlEscapeUri } from 'mu';
import { querySudo } from '@lblod/mu-auth-sudo';
import { getDocumentType, groupBySubcase } from './utils';
import {
  DOCUMENT_TYPES,
  SUBCASE_TYPES,
  DOCUMENT_REQUIREMENTS,
  KANSELARIJ_GRAPH_URI,
} from "../config";

/**
 * Checks if the passed in agendaitem has PUBLIEK and/or INTERN_OVERHEID
 * documents, which can be submitted to VP
 *
 * @param {string} agendaitemUri The uri of the agendaitem we want to check
 * @returns {Promise<boolean>} Whether the agendaitem is ready to be sent
 */
async function isAgendaItemReadyForVP(agendaitemUri) {
  const queryString = `
PREFIX besluitvorming: <https://data.vlaanderen.be/ns/besluitvorming#>
PREFIX pav: <http://purl.org/pav/>
PREFIX dct: <http://purl.org/dc/terms/>

ASK {
  VALUES ?agendaitem {
    ${sparqlEscapeUri(agendaitemUri)}
  }
  {
    ?agendaitem besluitvorming:geagendeerdStuk ?piece .
  }
  UNION
  {
    ?treatment dct:subject ?agendaitem ;
              besluitvorming:heeftBeslissing ?decisionActivity .
    ?piece besluitvorming:beschrijft ?decisionActivity .
  }
  FILTER NOT EXISTS { ?nextVersion pav:previousVersion ?piece . }
  ?piece besluitvorming:vertrouwelijkheidsniveau ?vertrouwelijkheidsniveau .
}`;
  const response = await query(queryString);
  return response?.boolean;
}

/**
 * Returns the decisionmakingFlow for the passed agendaitem
 *
 * @param {string} agendaitemUri The uri of the agendaitem
 * @returns {Promise<string>}
 */
async function getDecisionmakingFlowForAgendaitem(agendaitemUri) {
  const queryString = `
PREFIX besluitvorming: <https://data.vlaanderen.be/ns/besluitvorming#>
PREFIX dossier: <https://data.vlaanderen.be/ns/dossier#>

SELECT DISTINCT ?decisionmakingFlow
FROM ${sparqlEscapeUri(KANSELARIJ_GRAPH_URI)}
{
  VALUES ?agendaitem {
    ${sparqlEscapeUri(agendaitemUri)}
  }
  ?agendaActivity besluitvorming:genereertAgendapunt ?agendaitem ;
                  besluitvorming:vindtPlaatsTijdens ?subcase .
  ?decisionmakingFlow dossier:doorloopt ?subcase .
} LIMIT 1`;
  const response = await querySudo(queryString);
  if (response?.results?.bindings?.length > 0) {
    return response.results.bindings[0].decisionmakingFlow.value;
  }
  return;
}

/**
 * Returns the subcase type for the passed agendaitem
 *
 * @param {string} agendaitemUri The uri of the agendaitem
 * @returns {Promise<string>}
 */
async function getSubcaseTypeForAgendaitem(agendaitemUri) {
  const queryString = `
PREFIX besluitvorming: <https://data.vlaanderen.be/ns/besluitvorming#>
PREFIX pav: <http://purl.org/pav/>
PREFIX dct: <http://purl.org/dc/terms/>

SELECT DISTINCT ?subcaseType {
  VALUES ?agendaitem {
    ${sparqlEscapeUri(agendaitemUri)}
  }
  ?agendaActivity besluitvorming:genereertAgendapunt ?agendaitem ;
                  besluitvorming:vindtPlaatsTijdens ?subcase .
  ?subcase dct:type ?subcaseType .
} LIMIT 1`;
  const response = await query(queryString);
  if (response?.results?.bindings?.length > 0) {
    return response.results.bindings[0].subcaseType.value;
  }
  return;
}

/**
 * Returns the document types for the passed agendaitem
 *
 * @param {string} agendaitemUri The uri of the agendaitem
 * @returns {Promise<Array<string>>}
 */
async function getDocumentTypesForAgendaitem(agendaitemUri) {
  const queryString = `
PREFIX besluitvorming: <https://data.vlaanderen.be/ns/besluitvorming#>
PREFIX pav: <http://purl.org/pav/>
PREFIX dct: <http://purl.org/dc/terms/>
PREFIX dossier: <https://data.vlaanderen.be/ns/dossier#>

SELECT DISTINCT ?documentType {
  VALUES ?agendaitem {
    ${sparqlEscapeUri(agendaitemUri)}  }
  {
    ?agendaitem besluitvorming:geagendeerdStuk ?piece .
  }
  UNION
  {
    ?treatment dct:subject ?agendaitem ;
              besluitvorming:heeftBeslissing ?decisionActivity .
    ?piece besluitvorming:beschrijft ?decisionActivity .
  }
  FILTER NOT EXISTS { ?nextVersion pav:previousVersion ?piece . }
  ?piece besluitvorming:vertrouwelijkheidsniveau ?vertrouwelijkheidsniveau .
  ?documentContainer dossier:Collectie.bestaatUit ?piece .
  ?documentContainer dct:type ?documentType .
}`;
  const response = await query(queryString);
  if (response?.results?.bindings) {
    return response.results.bindings.map((binding) => binding.documentType.value);
  }
  return [];
}

/**
 * Returns the pieces for a passed agendaitem
 *
 * @param {string} agendaitemUri The uri of the agendaitem
 * @returns {Promise<Array<string>>}
 */
async function getPiecesForAgendaitem(agendaitemUri, includePreviousAgendaitems) {
  //decisionmakingflow ophalen
  let queryString = `
  PREFIX besluitvorming: <https://data.vlaanderen.be/ns/besluitvorming#>
  PREFIX pav: <http://purl.org/pav/>
  PREFIX dct: <http://purl.org/dc/terms/>
  PREFIX dossier: <https://data.vlaanderen.be/ns/dossier#>
  PREFIX ext: <http://mu.semte.ch/vocabularies/ext/>
  PREFIX prov: <http://www.w3.org/ns/prov#>

  SELECT DISTINCT (?piece AS ?uri)
  WHERE {
    VALUES ?agendaitem {
      ${sparqlEscapeUri(agendaitemUri)}
    }

    VALUES ?bekrachtigingVlaamseRegering {
      ${sparqlEscapeUri(SUBCASE_TYPES.BEKRACHTIGING_VLAAMSE_REGERING)}
    }
    `;

    if(includePreviousAgendaitems) {
      queryString += `
    ?agendaActivity besluitvorming:genereertAgendapunt ?agendaitem ;
                    besluitvorming:vindtPlaatsTijdens / ^dossier:doorloopt ?decisionmakingFlow .

    ?decisionmakingFlow dossier:doorloopt ?subcase .

    FILTER NOT EXISTS { ?subcase dct:type ?bekrachtigingVlaamseRegering . }
    ?submissionActivity ext:indieningVindtPlaatsTijdens ?subcase .
    ?subcaseDecisionActivity ext:beslissingVindtPlaatsTijdens ?subcase .
    { ?submissionActivity prov:generated ?piece . }
    UNION
    { ?piece besluitvorming:beschrijft ?subcaseDecisionActivity . }
      `;
    } else {
      queryString += `
    {
      ?agendaitem besluitvorming:geagendeerdStuk ?piece .
    }
    UNION
    {
      ?treatment dct:subject ?agendaitem ;
                besluitvorming:heeftBeslissing ?decisionActivity .
      ?piece besluitvorming:beschrijft ?decisionActivity .
    }`;
    }

      queryString +=`
    FILTER NOT EXISTS { ?nextVersion pav:previousVersion ?piece . }
    ?piece besluitvorming:vertrouwelijkheidsniveau ?vertrouwelijkheidsniveau .
    ?piece dct:title ?pieceName .
    ?documentContainer dossier:Collectie.bestaatUit ?piece .
    ?documentContainer dct:type ?documentType .
  } ORDER BY STR(?pieceName)`;
  const response = await query(queryString);
  if (response?.results?.bindings) {
    return response.results.bindings.map((binding) => binding.uri.value);
  }
  return [];
}

/**
 * Finds and returns all the pieces that are linked to an agendaitem and
 * that should be sent to the Flemish Parliament.
 * In case the agendaitem has a document of type DECREET, AND the subcaseType is
 * either DEFINITIEVE_GOEDKEURING or PRINCIPIELE_GOEDKEURING,
 * we defer to the special decisionmakingFlow getPieceUris function.
 * In all other cases, we get the list of pieces on the current agendaitem.
 * @param {string} agendaitemUri
 * @returns {Promise<Array<string>>} A promise that resolves to an array with the
 *   URIs of the valid pieces
 */
async function getPieceUris(agendaitemUri) {
  const documentTypes = await getDocumentTypesForAgendaitem(agendaitemUri);
  const subcaseType = await getSubcaseTypeForAgendaitem(agendaitemUri);
  if (documentTypes.indexOf(DOCUMENT_TYPES.DECREET) > -1 &&
    (
      subcaseType === SUBCASE_TYPES.DEFINITIEVE_GOEDKEURING ||
      subcaseType === SUBCASE_TYPES.PRINCIPIELE_GOEDKEURING
    )
  ) {
    return getPiecesForAgendaitem(agendaitemUri, true)
  }
  const pieces = await getPiecesForAgendaitem(agendaitemUri, false)
  return pieces;
}

function hasFileOfType (pieces, pieceType, fileType) {
  for (const piece of pieces) {
    if (piece.type.uri === pieceType && piece.files) {
      for (const file of piece.files) {
        if (file[fileType]) {
          return true;
        }
      }
    }
  }
  return false;
}

/**
 * Checks the config to determine which pieces are missing for an agendaitem.
 * @param {string} agendaitemUri
 * @param {Piece[]} pieces
 * @returns {Promise<Piece[]>}
*/

async function getMissingPieces (agendaitemUri, pieces) {
  const documentTypes = await getDocumentTypesForAgendaitem(agendaitemUri);
  let missingPiecesObject = {};
  let subcasesWithPieces = groupBySubcase(pieces);
  for (const requirementGroup of DOCUMENT_REQUIREMENTS) {
    if (documentTypes.includes(requirementGroup.documentType)) {
      for (const requirement of requirementGroup.requirements) {
        for (const subcase in subcasesWithPieces) {
          if (subcasesWithPieces.hasOwnProperty(subcase)) {
            const subcaseWithPieces = subcasesWithPieces[subcase];
            const subcaseName = subcaseWithPieces.subcaseName || 'default';
            if (subcaseWithPieces.subcaseType === requirement.subcaseType) {
              for (const requiredPiece of requirement.requiredPieces) {
                const pieceTypeLabel = (
                  await getDocumentType(requiredPiece.pieceType)
                ).altLabel;
                for (const fileType of requiredPiece.fileTypes) {
                  if (
                    !hasFileOfType(
                      subcaseWithPieces.pieces,
                      requiredPiece.pieceType,
                      fileType
                    )
                  ) {
                    if (!missingPiecesObject[subcaseName]) {
                      missingPiecesObject[subcaseName] = {};
                    }
                    if (!missingPiecesObject[subcaseName][pieceTypeLabel]) {
                      missingPiecesObject[subcaseName][pieceTypeLabel] = [];
                    }
                    let requiredFileTypes = {};
                    requiredFileTypes[fileType] = true;
                    missingPiecesObject[subcaseName][pieceTypeLabel].push(requiredFileTypes);
                  }
                }
              }
            }
          }
        }
      }
    }
  }

  let missingPieces = [];
  for (const subcaseName in missingPiecesObject) {
    if (missingPiecesObject.hasOwnProperty(subcaseName)) {
      for (const pieceTypeLabel in missingPiecesObject[subcaseName]) {
        if (missingPiecesObject[subcaseName].hasOwnProperty(pieceTypeLabel)) {
          missingPieces.push({
            subcaseName: subcaseName === 'default' ? undefined : subcaseName,
            type: {
              label: pieceTypeLabel,
            },
            files: missingPiecesObject[subcaseName][pieceTypeLabel]
          })
        }
      }
    }
  }

  return missingPieces;
}

function findPieceOfType(pieces, pieceType) {
  for (const piece of pieces) {
    if (piece.type.uri === pieceType) {
      return piece;
    }
  }
  return null;
}

/**
 * Checks the config to determine which pieces are required for an agendaitem.
 * Returns the URIs for these pieces
 * @param {string} agendaitemUri
 * @param {Piece[]} pieces
 * @returns {Promise<Piece[]>}
*/
async function getRequiredPieces (agendaitemUri, pieces) {
  const documentTypes = await getDocumentTypesForAgendaitem(agendaitemUri);
  let requiredPieces = [];
  let subcasesWithPieces = groupBySubcase(pieces);
  let hasRequiredPieces = false;
  for (const requirementGroup of DOCUMENT_REQUIREMENTS) {
    if (documentTypes.includes(requirementGroup.documentType)) {
      for (const requirement of requirementGroup.requirements) {
        for (const subcase in subcasesWithPieces) {
          if (subcasesWithPieces.hasOwnProperty(subcase)) {
            const subcaseWithPieces = subcasesWithPieces[subcase];
            if (subcaseWithPieces.subcaseType === requirement.subcaseType) {
              hasRequiredPieces = true;
              for (const requiredPiece of requirement.requiredPieces) {
                let piece = findPieceOfType(subcaseWithPieces.pieces, requiredPiece.pieceType);
                if (piece) {
                  requiredPieces.push(piece);
                }
              }
            }
          }
        }
      }
    }
  }

  if (requiredPieces.length === 0 && !hasRequiredPieces) {
    return pieces;
  }

  return requiredPieces;
}

export {
  isAgendaItemReadyForVP,
  getPieceUris,
  getMissingPieces,
  getRequiredPieces,
  getDecisionmakingFlowForAgendaitem
}
