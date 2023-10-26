import {
  query,
  update,
  sparqlEscapeUri,
  sparqlEscapeDate,
  sparqlEscapeDateTime,
  sparqlEscapeString,
  uuid,
} from "mu";

import { parseSparqlResults } from "./utils";

const RESOURCE_BASE = "http://themis.vlaanderen.be/id/";

async function getParliamentFlowAndSubcase(decisionmakingFlowUri) {
  const queryString = `
PREFIX dossier: <https://data.vlaanderen.be/ns/dossier#>
PREFIX parl: <http://mu.semte.ch/vocabularies/ext/parlement/>

SELECT ?parliamentFlow ?parliamentSubcase
WHERE {
  VALUES ?decisionmakingFlow {
    ${sparqlEscapeUri(decisionmakingFlowUri)}
  }
  ?case dossier:Dossier.isNeerslagVan ?decisionmakingFlow .
  ?case parl:behandeltDossier ?parliamentFlow .
  ?parliamentFlow parl:parlementaireProcedurestap ?parliamentSubcase .
}`;
  const response = await query(queryString);
  const parsed = parseSparqlResults(response)?.[0];
  return parsed ?? { parliamentFlow: null, parliamentSubcase: null };
}

/**
 * @param {string} uri
 * @returns {Promise<?DecisionmakingFlow>}
 */
async function createParliamentFlow(parliamentId, decisionmakingFlowUri) {
  const id = uuid();
  const parliamentFlowUri = `${RESOURCE_BASE}parlementaireaangelegenheid/${id}`;
  const queryString = `
PREFIX dossier: <https://data.vlaanderen.be/ns/dossier#>
PREFIX parl: <http://mu.semte.ch/vocabularies/ext/parlement/>
PREFIX xsd: <http://www.w3.org/2001/XMLSchema#>
PREFIX mu: <http://mu.semte.ch/vocabularies/core/>

INSERT {
  ${sparqlEscapeUri(parliamentFlowUri)} 
    a parl:Parlementaireaangelegenheid ;
    mu:uuid ${sparqlEscapeString(id)} ;
    dossier:openingsdatum ${sparqlEscapeDate(new Date())} ;
    parl:id ${sparqlEscapeString(parliamentId)} .
  ?case parl:behandeltDossier ${sparqlEscapeUri(parliamentFlowUri)} .
} WHERE {
  ?case dossier:Dossier.isNeerslagVan ${sparqlEscapeUri(
    decisionmakingFlowUri
  )} .
}`;
  await update(queryString);

  return parliamentFlowUri;
}

/**
 * @param {string} uri
 * @returns {Promise<?DecisionmakingFlow>}
 */
async function createParliamentSubcase(parliamentFlowUri) {
  const id = uuid();
  const uri = `${RESOURCE_BASE}parlementaire-procedurestap/${id}`;
  const queryString = `
PREFIX dossier: <https://data.vlaanderen.be/ns/dossier#>
PREFIX parl: <http://mu.semte.ch/vocabularies/ext/parlement/>
PREFIX mu: <http://mu.semte.ch/vocabularies/core/>

INSERT DATA {
  ${sparqlEscapeUri(uri)} 
    a parl:ParlementaireProcedurestap ;
    mu:uuid ${sparqlEscapeString(id)} ;
    dossier:Procedurestap.startdatum ${sparqlEscapeDateTime(new Date())} .
  ${sparqlEscapeUri(
    parliamentFlowUri
  )} parl:parlementaireProcedurestap ${sparqlEscapeUri(uri)} . 
}`;
  await update(queryString);

  return uri;
}

async function createSubmissionActivity(subcaseUri, pieces, submitterUri) {
  const id = uuid();
  const uri = `${RESOURCE_BASE}parlementaire-indieningsactiviteit/${id}`;
  const queryString = `
PREFIX dossier: <https://data.vlaanderen.be/ns/dossier#>
PREFIX parl: <http://mu.semte.ch/vocabularies/ext/parlement/>
PREFIX mu: <http://mu.semte.ch/vocabularies/core/>
PREFIX prov: <http://www.w3.org/ns/prov#>

INSERT {
  ${sparqlEscapeUri(uri)} 
    a parl:ParlementaireIndieningsactiviteit ;
    mu:uuid ${sparqlEscapeString(id)} ;
    dossier:Procedurestap.startdatum ${sparqlEscapeDateTime(new Date())} ;
    parl:ingediendStuk ?piece ;
    prov:wasAssociatedWith ${sparqlEscapeUri(submitterUri)} .
  ${sparqlEscapeUri(subcaseUri)} parl:parlementaireIndieningsactiviteiten ${sparqlEscapeUri(uri)} .
} WHERE {
  VALUES ?piece {
    ${pieces.map((piece) => sparqlEscapeUri(piece.uri)).join(" ")}
  }
}`;
  await update(queryString);

  return uri;
}

export {
  getParliamentFlowAndSubcase,
  createParliamentFlow,
  createParliamentSubcase,
  createSubmissionActivity,
};
