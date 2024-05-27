import {
  update,
  sparqlEscapeUri,
  sparqlEscapeDateTime,
  sparqlEscapeString,
  uuid,
} from "mu";
import { querySudo, updateSudo } from "@lblod/mu-auth-sudo";
import {
  KANSELARIJ_GRAPH_URI,
  MANDATE_ROLES,
  PUBLIC_GRAPH_URI,
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
${prefixHeaderLines.besluitvorming}
${prefixHeaderLines.dct}
${prefixHeaderLines.dossier}
${prefixHeaderLines.parl}
${prefixHeaderLines.skos}

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

async function getLatestSubcase(decisionmakingFlowUri, subcaseType) {
  const queryString = `
    ${prefixHeaderLines.dct}
    ${prefixHeaderLines.dossier}

    SELECT DISTINCT ?uri ?title WHERE {
      GRAPH ${sparqlEscapeUri(KANSELARIJ_GRAPH_URI)} {
        ${sparqlEscapeUri(decisionmakingFlowUri)} dossier:doorloopt ?uri .
        OPTIONAL { ?uri dct:title ?title . }
        ${subcaseType ? `?uri dct:type ${sparqlEscapeUri(subcaseType)} .` : ''}
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

async function getLatestGovernmentAreas(subcaseUri) {

  const queryString = `
  ${prefixHeaderLines.besluitvorming}

  SELECT ?uri WHERE {
    GRAPH ${sparqlEscapeUri(KANSELARIJ_GRAPH_URI)} {
      ${sparqlEscapeUri(subcaseUri)} besluitvorming:beleidsveld ?uri .
    }
  }
`
const bindings = await querySudo(queryString);
const parsed = parseSparqlResults(bindings);

const governmentAreas = parsed ? parsed.map((area) => area.uri) : null;
return governmentAreas;
}

/**
 * [SUDO QUERY]
 *
 * @param {string} subcaseUri
 */
async function getCalculatedMandatees(subcaseUri) {
  const queryString = 
  `
  ${prefixHeaderLines.ext}
  ${prefixHeaderLines.mandaat}
  ${prefixHeaderLines.org}

  SELECT ?uri
  FROM ${sparqlEscapeUri(KANSELARIJ_GRAPH_URI)} 
  FROM ${sparqlEscapeUri(PUBLIC_GRAPH_URI)} 
  WHERE {
    ${sparqlEscapeUri(subcaseUri)} ext:heeftBevoegde ?mandate .
  
    ?mandate mandaat:isBestuurlijkeAliasVan ?persoon ;
              org:holds ?role .
    OPTIONAL
    {
      ?activeMandate mandaat:isBestuurlijkeAliasVan ?persoon ;
                      org:holds ?role .
      FILTER NOT EXISTS { ?activeMandate mandaat:einde ?einde . }
    }
    
    BIND(IF(BOUND(?activeMandate), ?activeMandate , ?mandate) AS ?uri)
  }
  `
  const bindings = await querySudo(queryString);
  const parsed = parseSparqlResults(bindings);

  const mandatees = parsed ? parsed.map((mandatee) => mandatee.uri) : null;
  return mandatees;
}

/**
 * [SUDO QUERY]
 */
async function getActiveMinisterPresident() {
  const queryString = 
  `
  ${prefixHeaderLines.ext}
  ${prefixHeaderLines.mandaat}
  ${prefixHeaderLines.org}
  
  SELECT ?uri
  FROM ${sparqlEscapeUri(PUBLIC_GRAPH_URI)} 
  WHERE {
    ?uri org:holds ${sparqlEscapeUri(MANDATE_ROLES.MINISTER_PRESIDENT)} .
    FILTER NOT EXISTS { ?uri mandaat:einde ?einde . }
  } LIMIT 1
  `
  const data = await querySudo(queryString);
  if (data?.results?.bindings.length) {
    return data.results.bindings[0].uri.value;
  }
  throw new Error(`There is no active Minister President!`);
}

/**
 * [SUDO QUERY]
 *
 * @param {string} title
 * @param {string} shortTitle
 * @param {string} subcaseType
 * @param {string} agendaItemType
 * @param {string[]} governmentAreas
 */
async function createSubcase(title, shortTitle, subcaseType, agendaItemType, decisionmakingFlowUri, definitiveMandatees, governmentAreas, isSudo) {
  const subcaseId = uuid();
  const subcaseUri = `${RESOURCE_BASE}procedurestap/${subcaseId}`;
  const now = new Date();

  const queryString = `
${prefixHeaderLines.mu}
${prefixHeaderLines.ext}
${prefixHeaderLines.dct}
${prefixHeaderLines.dossier}
${prefixHeaderLines.besluitvorming}
${prefixHeaderLines.xsd}

INSERT DATA {
  GRAPH ${sparqlEscapeUri(KANSELARIJ_GRAPH_URI)} {
    ${sparqlEscapeUri(decisionmakingFlowUri)} dossier:doorloopt ${sparqlEscapeUri(subcaseUri)} .
    ${sparqlEscapeUri(subcaseUri)} a dossier:Procedurestap ;
      mu:uuid ${sparqlEscapeString(subcaseId)} ;
      ${shortTitle ? `dct:alternative ${sparqlEscapeString(shortTitle)} ;` : ''}
      ${title ? `dct:title ${sparqlEscapeString(title)} ;` : ''}
      dct:created ${sparqlEscapeDateTime(now)} ;
      ext:modified ${sparqlEscapeDateTime(now)} ;
      dct:type ${sparqlEscapeUri(subcaseType)} ;
      ${governmentAreas?.length ? `besluitvorming:beleidsveld ${governmentAreas.map(sparqlEscapeUri).join(', ')} ;` : ''}
      ${definitiveMandatees?.length ? `ext:bekrachtigdDoor ${definitiveMandatees.map(sparqlEscapeUri).join(', ')} ;` : ''}
      ext:agendapuntType ${sparqlEscapeUri(agendaItemType)} .
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
  getLatestGovernmentAreas,
  getCalculatedMandatees,
  getActiveMinisterPresident,
}
