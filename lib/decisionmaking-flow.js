import { query, sparqlEscapeUri } from 'mu';
import { ACCESS_LEVELS, DECISION_RESULT_CODES, DOCUMENT_TYPES, SUBCASE_TYPES } from '../config';

/**
 * Checks if the passed in decisionmaking flow has a subcase with type
 * "definitieve goedkeuring", a piece with type "decreet" linked to said subcase
 * and no subcase with type "bekrachtiging Vlaamse Regering". If so, it's
 * considered ready to be sent to the VP.
 *
 * @param {string} uri The uri of the decisionmaking flow we want to check
 * @returns {Promise<boolean>} Whether the decisionmaking flow is ready to be sent to the VP
 */
async function isDecisionMakingFlowReadyForVP(uri) {
  const queryString = `
PREFIX besluitvorming: <https://data.vlaanderen.be/ns/besluitvorming#>
PREFIX prov: <http://www.w3.org/ns/prov#>
PREFIX pav: <http://purl.org/pav/>
PREFIX dct: <http://purl.org/dc/terms/>
PREFIX ext: <http://mu.semte.ch/vocabularies/ext/>
PREFIX dossier: <https://data.vlaanderen.be/ns/dossier#>

ASK {
  VALUES ?decisionmakingFlow {
    ${sparqlEscapeUri(uri)}
  }
  VALUES ?decreet {
    ${sparqlEscapeUri(DOCUMENT_TYPES.DECREET)}
  }
  VALUES ?definitieveGoedkeuring {
    ${sparqlEscapeUri(SUBCASE_TYPES.DEFINITIEVE_GOEDKEURING)}
  }
  VALUES ?bekrachtigingVlaamseRegering {
    ${sparqlEscapeUri(SUBCASE_TYPES.BEKRACHTIGING_VLAAMSE_REGERING)}
  }
  VALUES ?goedgekeurd {
    ${sparqlEscapeUri(DECISION_RESULT_CODES.GOEDGEKEURD)}
  }
  VALUES ?vertrouwelijkheidsniveau {
    ${sparqlEscapeUri(ACCESS_LEVELS.INTERN_OVERHEID)}
    ${sparqlEscapeUri(ACCESS_LEVELS.PUBLIEK)}
  }

  ?decisionmakingFlow dossier:doorloopt ?subcase .

  ?decisionActivity ext:beslissingVindtPlaatsTijdens ?subcase .
  ?decisionActivity besluitvorming:resultaat ?goedgekeurd .

  FILTER NOT EXISTS {
    ?decisionmakingFlow dossier:doorloopt/dct:type ?bekrachtigingVlaamseRegering .
  }
  ?subcase dct:type ?definitieveGoedkeuring .
  ?submissionActivity ext:indieningVindtPlaatsTijdens ?subcase .
  FILTER NOT EXISTS { ?nextVersion pav:previousVersion ?piece . }
  ?submissionActivity prov:generated ?piece .
  ?piece besluitvorming:vertrouwelijkheidsniveau ?vertrouwelijkheidsniveau .
  ?documentContainer dossier:Collectie.bestaatUit ?piece .
  ?documentContainer dct:type ?decreet .
}`;
  const response = await query(queryString);
  return response?.boolean;
}

/** @typedef {string} uri */

/**
 * @typedef {Object} GovernmentField
 * @property {uri} uri
 * @property {string} label
 */

/**
 * @typedef {Object} DecisionmakingFlow
 * @property {uri} uri
 * @property {string} name
 * @property {string} altName
 * @property {uri} case
 * @property {GovernmentField[]} governmentFields
 */

/**
 * @param {string} uri
 * @returns {Promise<?DecisionmakingFlow>}
 */
async function getDecisionmakingFlow(uri) {
  const queryString = `
PREFIX dct: <http://purl.org/dc/terms/>
PREFIX skos: <http://www.w3.org/2004/02/skos/core#>
PREFIX dossier: <https://data.vlaanderen.be/ns/dossier#>
PREFIX besluitvorming: <https://data.vlaanderen.be/ns/besluitvorming#>

SELECT DISTINCT ?decisionmakingFlow ?case ?name ?altName ?governmentField ?governmentFieldLabel
WHERE {
  VALUES ?decisionmakingFlow {
    ${sparqlEscapeUri(uri)}
  }

  OPTIONAL {
    ?decisionmakingFlow besluitvorming:beleidsveld ?governmentField .
    ?governmentField skos:prefLabel ?governmentFieldLabel .
  }
  ?case dossier:Dossier.isNeerslagVan ?decisionmakingFlow .
  OPTIONAL { ?case dct:title ?name . }
  ?case dct:alternative ?altName .
}`;
  const response = await query(queryString);
  if (!response?.results?.bindings?.length) {
    return null;
  }

  const bindings = response.results.bindings;
  return bindings.reduce(
    (accumulator, binding) => {
      accumulator.uri ??= binding.decisionmakingFlow.value;
      accumulator.case ??= binding.case.value;
      // In practice, name is empty for now because we don't set it in the frontend
      accumulator.name ??= binding.name?.value;
      accumulator.altName ??= binding.altName.value;
      if (!accumulator.name) {
        accumulator.name = accumulator.altName;
      }

      accumulator.governmentFields ??= [];
      const governmentFieldUri = binding.governmentField?.value;
      const governmentFieldLabel = binding.governmentFieldLabel?.value;
      if (governmentFieldUri && governmentFieldLabel) {
        accumulator.governmentFields.push({
          uri: governmentFieldUri,
          label: governmentFieldLabel
        });
      }
      return accumulator;
    },
    {}
  );
}

/**
 * @param {string} uri
 */
async function getPieces(uri) {
  const queryString = `
PREFIX besluitvorming: <https://data.vlaanderen.be/ns/besluitvorming#>
PREFIX prov: <http://www.w3.org/ns/prov#>
PREFIX pav: <http://purl.org/pav/>
PREFIX dct: <http://purl.org/dc/terms/>
PREFIX ext: <http://mu.semte.ch/vocabularies/ext/>
PREFIX dossier: <https://data.vlaanderen.be/ns/dossier#>
PREFIX mu: <http://mu.semte.ch/vocabularies/core/>
PREFIX nie: <http://www.semanticdesktop.org/ontologies/2007/01/19/nie#>

SELECT DISTINCT (?piece AS ?uri)
WHERE {
  VALUES ?decisionmakingFlow {
    ${sparqlEscapeUri(uri)}
  }

  VALUES ?documentType {
    ${sparqlEscapeUri(DOCUMENT_TYPES.BESLISSINGSFICHE)}
    ${sparqlEscapeUri(DOCUMENT_TYPES.DECREET)}
    ${sparqlEscapeUri(DOCUMENT_TYPES.MEMORIE)}
    ${sparqlEscapeUri(DOCUMENT_TYPES.NOTA)}
    ${sparqlEscapeUri(DOCUMENT_TYPES.ADVIES)}
  }
 VALUES ?subcaseType {
    ${sparqlEscapeUri(SUBCASE_TYPES.DEFINITIEVE_GOEDKEURING)}
    ${sparqlEscapeUri(SUBCASE_TYPES.BEKRACHTIGING_VLAAMSE_REGERING)}
 }
  VALUES ?bekrachtigingVlaamseRegering {
    ${sparqlEscapeUri(SUBCASE_TYPES.BEKRACHTIGING_VLAAMSE_REGERING)}
  }
  VALUES ?goedgekeurd {
    ${sparqlEscapeUri(DECISION_RESULT_CODES.GOEDGEKEURD)}
  }
  VALUES ?vertrouwelijkheidsniveau {
    ${sparqlEscapeUri(ACCESS_LEVELS.INTERN_OVERHEID)}
    ${sparqlEscapeUri(ACCESS_LEVELS.PUBLIEK)}
  }

  ?decisionmakingFlow a besluitvorming:Besluitvormingsaangelegenheid .

  ?decisionmakingFlow dossier:doorloopt ?subcase .

  ?decisionActivity ext:beslissingVindtPlaatsTijdens ?subcase .
  ?decisionActivity besluitvorming:resultaat ?goedgekeurd .

  FILTER NOT EXISTS { ?subcase dct:type ?bekrachtigingVlaamseRegering . }
  ?submissionActivity ext:indieningVindtPlaatsTijdens ?subcase .
  { ?submissionActivity prov:generated ?piece . }
  UNION
  { ?piece besluitvorming:beschrijft ?decisionActivity . }

  ?piece dct:title ?pieceName .
  FILTER NOT EXISTS { ?nextVersion pav:previousVersion ?piece . }
  ?piece besluitvorming:vertrouwelijkheidsniveau ?vertrouwelijkheidsniveau .
  ?documentContainer dossier:Collectie.bestaatUit ?piece .
  ?documentContainer dct:type ?documentType .
}`;
  const response = await query(queryString);
  return response;
}

/**
 * @typedef {Object} Concept
 * @property {uri} uri
 * @property {string} label
 */

/**
 * @typedef {Object} File
 * @property {uri} uri
 * @property {string} format
 * @property {uri} shareUri
 */

/**
 * @typedef {Object} Piece
 * @property {uri} uri
 * @property {string} name
 * @property {Date} created
 * @property {Concept} type
 * @property {File[]} files
 */

/**
 * @param {string[]} uris
 * @returns {Promise<Piece[]>}
 */
async function getFiles(uris) {
  const queryString = `
PREFIX besluitvorming: <https://data.vlaanderen.be/ns/besluitvorming#>
PREFIX prov: <http://www.w3.org/ns/prov#>
PREFIX pav: <http://purl.org/pav/>
PREFIX dct: <http://purl.org/dc/terms/>
PREFIX ext: <http://mu.semte.ch/vocabularies/ext/>
PREFIX sign: <http://mu.semte.ch/vocabularies/ext/handtekenen/>
PREFIX dossier: <https://data.vlaanderen.be/ns/dossier#>
PREFIX mu: <http://mu.semte.ch/vocabularies/core/>
PREFIX nie: <http://www.semanticdesktop.org/ontologies/2007/01/19/nie#>
PREFIX skos: <http://www.w3.org/2004/02/skos/core#>
PREFIX schema: <http://schema.org/>
PREFIX nfo: <http://www.semanticdesktop.org/ontologies/2007/03/22/nfo#>
PREFIX dbpedia: <http://dbpedia.org/ontology/>

SELECT DISTINCT ?piece ?name ?created ?type ?typeLabel ?virtualFile ?format ?shareUri ?fileExtension ?isSigned
WHERE {
  VALUES ?piece {
    ${uris.map(sparqlEscapeUri).join('\n    ')}
  }

  ?documentContainer dossier:Collectie.bestaatUit ?piece .
  ?documentContainer dct:type ?type .
  ?type skos:altLabel ?typeLabel .

  ?piece dct:title ?name ;
    dct:created ?created .

  {
    ?piece prov:value ?virtualFile .
    BIND (false AS ?isSigned)
  }
  UNION
  {
    ?piece prov:value/^prov:hadPrimarySource ?virtualFile .
    BIND (false AS ?isSigned)
  }
  UNION
  {
    ?piece sign:getekendStukKopie/prov:value ?virtualFile
    BIND (true AS ?isSigned)
  }

  ?virtualFile dct:format ?format .
  ?virtualFile dbpedia:fileExtension ?fileExtension .
  ?shareUri nie:dataSource ?virtualFile .

  {
    ?submissionActivity prov:generated ?piece .
    ?submissionActivity ext:indieningVindtPlaatsTijdens ?subcase .
  }
  UNION
  {
    ?piece besluitvorming:beschrijft ?decisionActivity .
    ?decisionActivity ext:beslissingVindtPlaatsTijdens ?subcase .
  }
  ?subcase dct:created ?subcaseCreated .
}
ORDER BY DESC(?subcaseCreated) ?name`;
  const response = await query(queryString);
  if (!response?.results?.bindings) {
    return null;
  }

  const bindings = response.results.bindings;
  const pieceMap = bindings.reduce(
    (map, binding) => {
      const uri = binding.piece.value;
      const piece = map.get(uri) ?? {};

      piece.uri = uri;
      piece.name = binding.name.value;
      piece.created = new Date(binding.created.value);
      piece.type = {
        uri: binding.type.value,
        label: binding.typeLabel.value,
      };
      const files = piece.files ?? [];
      files.push({
        uri: binding.virtualFile.value,
        format: binding.format.value,
        shareUri: binding.shareUri.value,
        extension: binding.fileExtension.value,
        isSigned: binding.isSigned?.value === "1",
      });
      piece.files = files;

      map.set(uri, piece);
      return map;
    },
    new Map()
  );
  return Array.from(pieceMap.values());
}

export {
  isDecisionMakingFlowReadyForVP,
  getDecisionmakingFlow,
  getPieces,
  getFiles,
}
