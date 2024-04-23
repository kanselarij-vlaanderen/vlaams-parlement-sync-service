import {
  query,
  update,
  sparqlEscapeUri,
  sparqlEscapeDateTime,
  sparqlEscapeString,
  uuid,
} from "mu";
import { querySudo, updateSudo } from "@lblod/mu-auth-sudo";
import {
  ACCESS_LEVELS,
  DOCUMENT_TYPES,
  KANSELARIJ_GRAPH_URI,
  PUBLIC_GRAPH_URI,
  SUBCASE_TYPES,
  VP_GRAPH_URI,
} from "../config";
import { prefixHeaderLines, RESOURCE_BASE } from "../constants";
import { parseSparqlResults } from "./utils";

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
FROM ${sparqlEscapeUri(KANSELARIJ_GRAPH_URI)}
FROM ${sparqlEscapeUri(VP_GRAPH_URI)}
FROM ${sparqlEscapeUri(PUBLIC_GRAPH_URI)}
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
  const response = await querySudo(queryString);
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

async function getLatestSubcase(decisionmakingFlowUri) {
  const queryString = `
    PREFIX dct: <http://purl.org/dc/terms/>
    PREFIX dossier: <https://data.vlaanderen.be/ns/dossier#>

    SELECT DISTINCT ?uri ?title WHERE {
      GRAPH ${sparqlEscapeUri(KANSELARIJ_GRAPH_URI)} {
        ${sparqlEscapeUri(decisionmakingFlowUri)} dossier:doorloopt ?uri .
        OPTIONAL { ?uri dct:title ?title . }
        ?uri dct:created ?created .
      }
    } ORDER BY DESC(?created) LIMIT 1
  `
  const bindings = await querySudo(queryString);
  const parsed = parseSparqlResults(bindings);

  return parsed ? parsed[0] : null;
}

/**
 * [SUDO QUERY]
 *
 * @param {string} title
 * @param {string} shortTitle
 * @param {Date} openingDate
 * @param {string} subcaseType
 * @param {string} agendaItemType
 */
async function createCaseDecisionmakingFlowAndSubcase(title, shortTitle, openingDate, subcaseType, agendaItemType, isSudo) {
  const caseId = uuid();
  const caseUri = `${RESOURCE_BASE}dossier/${caseId}`;

  const decisionmakingFlowId = uuid();
  const decisionmakingFlowUri = `${RESOURCE_BASE}besluitvormingsaangelegenheid/${decisionmakingFlowId}`;

  const subcaseId = uuid();
  const subcaseUri = `${RESOURCE_BASE}procedurestap/${subcaseId}`;
  const now = new Date();

  const queryString = `
${prefixHeaderLines.mu}
${prefixHeaderLines.ext}
${prefixHeaderLines.dct}
${prefixHeaderLines.dossier}
${prefixHeaderLines.besluitvorming}

INSERT DATA {
  GRAPH ${sparqlEscapeUri(KANSELARIJ_GRAPH_URI)} {
    ${sparqlEscapeUri(caseUri)} a dossier:Dossier ;
      mu:uuid ${sparqlEscapeString(caseId)} ;
      ${shortTitle ? `dct:alternative ${sparqlEscapeString(shortTitle)} ;` : ''}
      dct:created ${sparqlEscapeDateTime(now)} ;
      dossier:Dossier.isNeerslagVan ${sparqlEscapeUri(decisionmakingFlowUri)} .
    ${sparqlEscapeUri(decisionmakingFlowUri)} a besluitvorming:Besluitvormingsaangelegenheid ;
      mu:uuid ${sparqlEscapeString(decisionmakingFlowId)} ;
      besluitvorming:openingsdatum ${sparqlEscapeDateTime(openingDate)} ;
      dossier:doorloopt ${sparqlEscapeUri(subcaseUri)} .
    ${sparqlEscapeUri(subcaseUri)} a dossier:Procedurestap ;
      mu:uuid ${sparqlEscapeString(subcaseId)} ;
      ${shortTitle ? `dct:alternative ${sparqlEscapeString(shortTitle)} ;` : ''}
      ${title ? `dct:title ${sparqlEscapeString(title)} ;` : ''}
      dct:created ${sparqlEscapeDateTime(now)} ;
      ext:modified ${sparqlEscapeDateTime(now)} ;
      dct:type ${sparqlEscapeUri(subcaseType)} ;
      ext:agendapuntType ${sparqlEscapeUri(agendaItemType)} .
  }
}`;
  const updateFunc = isSudo ? updateSudo : update;
  await updateFunc(queryString);
  return {
    caseUri,
    caseId,
    decisionmakingFlowUri,
    decisionmakingFlowId,
    subcaseUri,
    subcaseId,
  };
}

/**
 * [SUDO QUERY]
 *
 * @param {string} title
 * @param {string} shortTitle
 * @param {string} subcaseType
 * @param {string} agendaItemType
 */
async function createSubcase(title, shortTitle, subcaseType, agendaItemType, decisionmakingFlowUri, latestSubcaseUri, isSudo) {
  const subcaseId = uuid();
  const subcaseUri = `${RESOURCE_BASE}procedurestap/${subcaseId}`;
  const now = new Date();

  const queryString = `
${prefixHeaderLines.mu}
${prefixHeaderLines.ext}
${prefixHeaderLines.dct}
${prefixHeaderLines.dossier}
${prefixHeaderLines.besluitvorming}

INSERT {
  GRAPH ${sparqlEscapeUri(KANSELARIJ_GRAPH_URI)} {
    ${sparqlEscapeUri(decisionmakingFlowUri)} dossier:doorloopt ${sparqlEscapeUri(subcaseUri)} .
    ${sparqlEscapeUri(subcaseUri)} a dossier:Procedurestap ;
      mu:uuid ${sparqlEscapeString(subcaseId)} ;
      ${shortTitle ? `dct:alternative ${sparqlEscapeString(shortTitle)} ;` : ''}
      ${title ? `dct:title ${sparqlEscapeString(title)} ;` : ''}
      dct:created ${sparqlEscapeDateTime(now)} ;
      ext:modified ${sparqlEscapeDateTime(now)} ;
      dct:type ${sparqlEscapeUri(subcaseType)} ;
      ext:agendapuntType ${sparqlEscapeUri(agendaItemType)} ;
      ext:bekrachtigdDoor ?mandatee .
  }
} WHERE {
  GRAPH ${sparqlEscapeUri(KANSELARIJ_GRAPH_URI)} {
    ${sparqlEscapeUri(latestSubcaseUri)} ext:heeftBevoegde ?mandatee .
  }
}`;
  const updateFunc = isSudo ? updateSudo : update;
  await updateFunc(queryString);
  return {
    subcaseUri,
    subcaseId,
  };
}

/**
 * [SUDO QUERY]
 */
async function getDecisionmakingFlowId(uri) {
  const queryString = `${prefixHeaderLines.mu}

SELECT DISTINCT ?id
FROM ${sparqlEscapeUri(KANSELARIJ_GRAPH_URI)}
WHERE {
  ${sparqlEscapeUri(uri)} mu:uuid ?id .
}`;
  const response = await querySudo(queryString);
  const { id } = parseSparqlResults(response)[0];

  return id;
}

/**
 * [SUDO QUERY]
 */
async function getCaseFromDecisionmakingFlow(decisionmakingFlow) {
  const queryString = `${prefixHeaderLines.dossier}

SELECT DISTINCT ?case
FROM ${sparqlEscapeUri(KANSELARIJ_GRAPH_URI)}
WHERE {
  ?case dossier:Dossier.isNeerslagVan ${sparqlEscapeUri(decisionmakingFlow)} .
}`;
  const response = await querySudo(queryString);
  const { case: _case } = parseSparqlResults(response)[0];

  return _case;
}

/**
 * [SUDO QUERY]
 */
async function createSubmissionActivity(subcaseUri, pieceUris, isSudo) {
  const now = new Date();

  const id = uuid();
  const uri = `${RESOURCE_BASE}indieningsactiviteit/${id}`

  const queryString = `${prefixHeaderLines.mu}
${prefixHeaderLines.ext}
${prefixHeaderLines.prov}
${prefixHeaderLines.dossier}

INSERT DATA {
  GRAPH ${sparqlEscapeUri(KANSELARIJ_GRAPH_URI)} {
    ${sparqlEscapeUri(uri)} a ext:Indieningsactiviteit, prov:Activity ;
      mu:uuid ${sparqlEscapeString(id)} ;
      dossier:Activiteit.startdatum ${sparqlEscapeDateTime(now)} ;
      prov:generated ${pieceUris.map(sparqlEscapeUri).join(', ')} ;
      ext:indieningVindtPlaatsTijdens ${sparqlEscapeUri(subcaseUri)} .
  }
}`;
  const updateFunc = isSudo ? updateSudo : update;
  await updateFunc(queryString);
  return uri;
}

export {
  getDecisionmakingFlow,
  createSubcase,
  createCaseDecisionmakingFlowAndSubcase,
  createSubmissionActivity,
  getDecisionmakingFlowId,
  getCaseFromDecisionmakingFlow,
  getLatestSubcase,
}
