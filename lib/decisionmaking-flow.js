import { query, sparqlEscapeUri } from 'mu';
import { ACCESS_LEVELS, DECISION_RESULT_CODES, DOCUMENT_TYPES, SUBCASE_TYPES } from '../config';

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
PREFIX parl: <http://mu.semte.ch/vocabularies/ext/parlement/>

SELECT DISTINCT
?decisionmakingFlow ?case ?name ?altName
?governmentField ?governmentFieldLabel
?parliamentFlow ?pobj
WHERE {
  VALUES ?decisionmakingFlow {
    ${sparqlEscapeUri(uri)}
  }

  ?case dossier:Dossier.isNeerslagVan ?decisionmakingFlow .
  OPTIONAL { ?case dct:title ?name . }
  ?case dct:alternative ?altName .

  OPTIONAL {
    ?decisionmakingFlow besluitvorming:beleidsveld ?governmentField .
    ?governmentField skos:prefLabel ?governmentFieldLabel .
  }

  OPTIONAL {
    ?parliamentFlow parl:behandeltDossier ?case .
    ?parliamentFlow parl:id ?pobj
  }
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
      accumulator.parliamentFlow = binding.parliamentFlow?.value;
      accumulator.pobj = binding.pobj?.value;
      return accumulator;
    },
    {}
  );
}

/**
 * Finds and returns all the pieces that are linked to a decisionmaking flow and
 * that should be sent to the Flemish Parliament. The conditions for the piece
 * to be sendable are:
 *   - Piece has one of the following types:
 *     - Beslissingsfiche
 *     - Decreet
 *     - Memorie van Toelichting
 *     - Nota
 *     - Advies
 *   - Piece has either access level:
 *     - Intern overheid
 *     - Publiek
 *   - Piece is linked to a subcase and:
 *     - Subcase has a decision activity with result: Goedgekeurd
 *     - Subcase is not of type: Bekrachtiging Vlaamse Overheid
 *
 * @param {string} uri
 * @returns {Promise<Array<string>} A promise that resolves to an array with the
 *   URIs of the valid pieces
 */
async function getAllPieces(uri) {
  const queryString = `
PREFIX besluitvorming: <https://data.vlaanderen.be/ns/besluitvorming#>
PREFIX prov: <http://www.w3.org/ns/prov#>
PREFIX pav: <http://purl.org/pav/>
PREFIX dct: <http://purl.org/dc/terms/>
PREFIX ext: <http://mu.semte.ch/vocabularies/ext/>
PREFIX dossier: <https://data.vlaanderen.be/ns/dossier#>
PREFIX mu: <http://mu.semte.ch/vocabularies/core/>
PREFIX nie: <http://www.semanticdesktop.org/ontologies/2007/01/19/nie#>
PREFIX sign: <http://mu.semte.ch/vocabularies/ext/handtekenen/>

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
    ${sparqlEscapeUri(DOCUMENT_TYPES.ADVIES_IF)}
  }
  VALUES ?bekrachtigingVlaamseRegering {
    ${sparqlEscapeUri(SUBCASE_TYPES.BEKRACHTIGING_VLAAMSE_REGERING)}
  }
  VALUES ?vertrouwelijkheidsniveau {
    ${sparqlEscapeUri(ACCESS_LEVELS.INTERN_OVERHEID)}
    ${sparqlEscapeUri(ACCESS_LEVELS.PUBLIEK)}
  }

  ?decisionmakingFlow a besluitvorming:Besluitvormingsaangelegenheid .

  ?decisionmakingFlow dossier:doorloopt ?subcase .

  ?decisionActivity ext:beslissingVindtPlaatsTijdens ?subcase .
  ?subcase dct:created ?subcaseCreated .
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
} ORDER BY DESC(?subcaseCreated) STR(?pieceName)`;
  const response = await query(queryString);
  if (response?.results?.bindings) {
    return response.results.bindings.map((binding) => binding.uri.value);
  }
  return [];
}

export {
  getDecisionmakingFlow,
  getAllPieces,
}
