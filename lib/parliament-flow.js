import {
  query,
  update,
  sparqlEscapeUri,
  sparqlEscapeDate,
  sparqlEscapeDateTime,
  sparqlEscapeString,
  uuid,
} from "mu";

import { querySudo, updateSudo } from '@lblod/mu-auth-sudo';

import { parseSparqlResults } from "./utils";
import { KANSELARIJ_GRAPH_URI, PARLIAMENT_FLOW_STATUSES, VP_GRAPH_URI } from "../config";
import { prefixHeaderLines, RESOURCE_BASE } from "../constants";

/**
 * @typedef {Object} ParliamentFlow
 * @property {string} uri
 * @property {string} parliamentId
 */

/**
 * [QUERY]
 * @param {string} decisionmakingFlowUri
 * @returns {Promise<{parliamentFlow: ?string, parliamentSubcase: ?string}>}
 */
async function getParliamentFlowAndSubcase(decisionmakingFlowUri) {
  const queryString = `
PREFIX dossier: <https://data.vlaanderen.be/ns/dossier#>
PREFIX parl: <http://mu.semte.ch/vocabularies/ext/parlement/>

SELECT DISTINCT ?parliamentFlow ?parliamentSubcase
WHERE {
  VALUES ?decisionmakingFlow {
    ${sparqlEscapeUri(decisionmakingFlowUri)}
  }
  ?case dossier:Dossier.isNeerslagVan ?decisionmakingFlow .
  ?parliamentFlow parl:behandeltDossier ?case .
  ?parliamentFlow parl:parlementaireProcedurestap ?parliamentSubcase .
}`;
  const response = await query(queryString);
  const parsed = parseSparqlResults(response)?.[0];
  return {
    parliamentFlow: null,
    parliamentSubcase: null,
    ...parsed
  };
}


/**
 * [SUDO QUERY]
 *
 * @param {string[]} statuses Flows who have any of these status URI's will be returned.
 * @returns {Promise<ParliamentFlow[]>}
 */
async function getFlowsByStatus(statuses) {
  const queryString = `
PREFIX parl: <http://mu.semte.ch/vocabularies/ext/parlement/>
PREFIX adms: <http://www.w3.org/ns/adms#>

SELECT DISTINCT ?uri ?parliamentId
WHERE {
  GRAPH ${sparqlEscapeUri(VP_GRAPH_URI)} {
    VALUES ?status {
      ${statuses.map(sparqlEscapeUri).join('\n    ')}
    }
    ?uri a parl:Parlementaireaangelegenheid ;
      adms:status ?status ;
      parl:id ?parliamentId .
  }
}
`;
  const response = await querySudo(queryString);
  return parseSparqlResults(response);
}

/**
 * @param {string} parliamentId
 * @param {string} decisionmakingFlowUri
 * @param {string} status
 * @param {boolean} isSudo
 * @returns {Promise<string>} The uri of the parliamentary flow
 */
async function createParliamentFlow(parliamentId, decisionmakingFlowUri, status=PARLIAMENT_FLOW_STATUSES.INCOMPLETE, isSudo=false) {
  const id = uuid();
  const parliamentFlowUri = `${RESOURCE_BASE}parlementaireaangelegenheid/${id}`;
  const queryString = `
PREFIX dossier: <https://data.vlaanderen.be/ns/dossier#>
PREFIX parl: <http://mu.semte.ch/vocabularies/ext/parlement/>
PREFIX xsd: <http://www.w3.org/2001/XMLSchema#>
PREFIX mu: <http://mu.semte.ch/vocabularies/core/>
PREFIX adms: <http://www.w3.org/ns/adms#>

INSERT {
  GRAPH ${sparqlEscapeUri(VP_GRAPH_URI)} {
    ${sparqlEscapeUri(parliamentFlowUri)}
      a parl:Parlementaireaangelegenheid ;
      mu:uuid ${sparqlEscapeString(id)} ;
      adms:status ${sparqlEscapeUri(status)} ;
      dossier:openingsdatum ${sparqlEscapeDate(new Date())} ;
      parl:id ${sparqlEscapeString(parliamentId)} .
    ${sparqlEscapeUri(parliamentFlowUri)} parl:behandeltDossier ?case .
  }
} WHERE {
  ?case dossier:Dossier.isNeerslagVan ${sparqlEscapeUri(
    decisionmakingFlowUri
  )} .
}`;
  const updateFunc = isSudo ? updateSudo : update;
  await updateFunc(queryString);

  return parliamentFlowUri;
}

/**
 * @param {Partial<ParliamentFlow>[] | Partial<ParliamentFlow>} flows
 * @param {string} statusUri
 * @param {boolean} updateSudo
 */
async function updateParliamentFlowStatus(flowOrFlows, statusUri, isSudo=false) {
  let flows;
  if (!Array.isArray(flowOrFlows)) {
    flows = [flowOrFlows] 
  } else {
    flows = flowOrFlows
  }
  if (
    flows.some(
      (flow) =>
        !flow.hasOwnProperty("uri") && !flow.hasOwnProperty("parliamentId")
    )
  ) {
    throw new Error("Parliament flow needs parliamentId or uri property");
  }
  const queryString = `
${prefixHeaderLines.adms}
${prefixHeaderLines.parl}

DELETE {
  GRAPH ${sparqlEscapeUri(VP_GRAPH_URI)} {
    ?flowUri adms:status ?oldStatus .
  }
}
INSERT {
  GRAPH ${sparqlEscapeUri(VP_GRAPH_URI)} {
    ?flowUri adms:status ${sparqlEscapeUri(statusUri)} .
  }
} 
WHERE {
  VALUES (?flowUri ?parliamentId) {
    ${flows
      .map(
        ({uri, parliamentId}) =>
          `(${uri ? sparqlEscapeUri(uri) : "UNDEF"} ${
            parliamentId ? sparqlEscapeString(parliamentId) : "UNDEF"
          })`
      )
      .join("\n    ")}
  }
  GRAPH ${sparqlEscapeUri(VP_GRAPH_URI)} {
    ?flowUri parl:id ?parliamentId .
    OPTIONAL {
      ?flowUri adms:status ?oldStatus .
    }
  }
}`;
  const updateFunc = isSudo ? updateSudo : update;
  await updateFunc(queryString);
}

/**
 * @param {string} uri
 * @param {boolean} isSudo
 * @returns {Promise<string>} The uri of the parliamentary subcase
 */
async function createParliamentSubcase(parliamentFlowUri, isSudo=false) {
  const id = uuid();
  const uri = `${RESOURCE_BASE}parlementaire-procedurestap/${id}`;
  const queryString = `
PREFIX dossier: <https://data.vlaanderen.be/ns/dossier#>
PREFIX parl: <http://mu.semte.ch/vocabularies/ext/parlement/>
PREFIX mu: <http://mu.semte.ch/vocabularies/core/>

INSERT DATA {
  GRAPH ${sparqlEscapeUri(VP_GRAPH_URI)} {
    ${sparqlEscapeUri(uri)}
      a parl:ParlementaireProcedurestap ;
      mu:uuid ${sparqlEscapeString(id)} ;
      dossier:Procedurestap.startdatum ${sparqlEscapeDateTime(new Date())} .
    ${sparqlEscapeUri(
      parliamentFlowUri
    )} parl:parlementaireProcedurestap ${sparqlEscapeUri(uri)} .
  }
}`;
  const updateFunc = isSudo ? updateSudo : update;
  await updateFunc(queryString);

  return uri;
}

/**
 * [QUERY]
 *
 * @param {string} subcaseUri
 * @param {string} submitterUri
 * @returns {Promise<string>} The uri of the parliamentary submission activity
 */
async function createSubmissionActivity(subcaseUri, submitterUri, comment) {
  const id = uuid();
  const uri = `${RESOURCE_BASE}parlementaire-indieningsactiviteit/${id}`;
  if (!comment) {
    comment = '';
  }
  const queryString = `
PREFIX dossier: <https://data.vlaanderen.be/ns/dossier#>
PREFIX parl: <http://mu.semte.ch/vocabularies/ext/parlement/>
PREFIX mu: <http://mu.semte.ch/vocabularies/core/>
PREFIX prov: <http://www.w3.org/ns/prov#>
PREFIX dct: <http://purl.org/dc/terms/>

INSERT DATA {
  ${sparqlEscapeUri(uri)}
    a parl:ParlementaireIndieningsactiviteit ;
    mu:uuid ${sparqlEscapeString(id)} ;
    dct:description ${sparqlEscapeString(comment)} ;
    dossier:Procedurestap.startdatum ${sparqlEscapeDateTime(new Date())} ;
    prov:wasAssociatedWith ${sparqlEscapeUri(submitterUri)} .
  ${sparqlEscapeUri(subcaseUri)} parl:parlementaireIndieningsactiviteiten ${sparqlEscapeUri(uri)} .
}`;
  await update(queryString);

  return uri;
}

/**
 * [QUERY]
 *
 * @param {string} submissionActivityUri
 * @param {Array<Piece>} pieces
 * @returns {Promise<Array<string>>} The uris of the created submitted pieces
 */
async function createSubmittedPieces(submissionActivityUri, pieces) {
  const values = pieces.map((piece) => {
    const id = uuid();
    const uri = `${RESOURCE_BASE}parlementair-ingediend-stuk/${id}`;
    const name = piece.name;
    const subcaseName = piece.subcaseName;
    const subcaseCreated = piece.subcaseCreated;

    const pdfFile = piece.files.find((file) => file.isPdf);
    const wordFile = piece.files.find((file) => file.isWord);
    const signedFile = piece.files.find((file) => file.isSigned);

    const uri_ = sparqlEscapeUri(uri);
    const id_ = sparqlEscapeString(id);
    const piece_ = sparqlEscapeUri(piece.uri);
    const name_ = sparqlEscapeString(name);
    const subcaseName_ = subcaseName ? sparqlEscapeString(subcaseName) : 'UNDEF';
    const subcaseCreated_ = subcaseCreated ? sparqlEscapeDateTime(subcaseCreated) : 'UNDEF';

    const pdfUri = pdfFile?.uri ? sparqlEscapeUri(pdfFile.uri) : 'UNDEF';
    const pdfId = pdfFile?.parliamentId ? sparqlEscapeString(pdfFile.parliamentId) : 'UNDEF';

    const wordUri = wordFile?.uri ? sparqlEscapeUri(wordFile.uri) : 'UNDEF';
    const wordId = wordFile?.parliamentId ? sparqlEscapeString(wordFile.parliamentId) : 'UNDEF';

    const signedUri = signedFile?.uri ? sparqlEscapeUri(signedFile.uri) : 'UNDEF';
    const signedId = signedFile?.parliamentId ? sparqlEscapeString(signedFile.parliamentId) : 'UNDEF';

    return `(${uri_} ${id_} ${piece_} ${name_} ${subcaseName_} ${subcaseCreated_} ${pdfUri} ${pdfId} ${signedUri} ${signedId} ${wordUri} ${wordId})`;
  });

  const queryString = `
PREFIX parl: <http://mu.semte.ch/vocabularies/ext/parlement/>
PREFIX mu: <http://mu.semte.ch/vocabularies/core/>
PREFIX dct: <http://purl.org/dc/terms/>

INSERT {
  ?submittedPiece
    a parl:IngediendStuk ;
    parl:heeftStuk ?piece ;
    dct:title ?name ;
    parl:procedurestapAangemaaktOp ?subcaseCreated ;
    parl:procedurestapNaam ?subcaseName ;
    parl:ongetekendBestand ?unsignedFile ;
    parl:getekendBestand ?signedFile ;
    parl:wordBestand ?wordFile ;
    parl:ongetekendBestandId ?unsignedFileParliamentId ;
    parl:getekendBestandId ?signedFileParliamentId ;
    parl:wordBestandId ?wordFileParliamentId ;
    mu:uuid ?id .
  ${sparqlEscapeUri(submissionActivityUri)} parl:ingediendStuk ?submittedPiece
} WHERE {
  VALUES
  (?submittedPiece ?id ?piece ?name ?subcaseName ?subcaseCreated ?unsignedFile ?unsignedFileParliamentId ?signedFile ?signedFileParliamentId ?wordFile ?wordFileParliamentId)
  {
    ${values.join('\n    ')}
  }
}`;
  await update(queryString);
}

/**
 * [SUDO QUERY]
 *
 * @param {string} subcaseUri
 * @param {string} submitterUri
 * @returns {Promise<string>} The uri of the parliamentary submission activity
 */
async function createRetrievalActivity(parliamentarySubcaseUri, subcaseUri, themes) {
  const id = uuid();
  const uri = `${RESOURCE_BASE}parlementaire-ophalingsactiviteit/${id}`;

  const queryString = `
${prefixHeaderLines.dct}
${prefixHeaderLines.prov}
${prefixHeaderLines.mu}
${prefixHeaderLines.parl}
${prefixHeaderLines.dossier}

INSERT DATA {
  GRAPH ${sparqlEscapeUri(VP_GRAPH_URI)} {
    ${sparqlEscapeUri(uri)}
      a parl:ParlementaireOphalingsactiviteit ;
      mu:uuid ${sparqlEscapeString(id)} ;
      ${themes?.length ? `dct:description ${themes.map(sparqlEscapeString).join(', ')} ;` : ''}
      dossier:Procedurestap.startdatum ${sparqlEscapeDateTime(new Date())} .
    ${sparqlEscapeUri(parliamentarySubcaseUri)} parl:parlementaireOphalingsactiviteit ${sparqlEscapeUri(uri)} .
    ${sparqlEscapeUri(uri)} prov:generated ${sparqlEscapeUri(subcaseUri)} .
  }
}`;
  await updateSudo(queryString);

  return uri;
}

/**
 * [SUDO QUERY]
 *
 * @param {string} retrievalActivityUri
 * @param {string} title
 * @param {string} pieceUri
 * @param {Object} {} The uri and pfls mapping of the virtual files
 */
async function createRetrievedPiece(retrievalActivityUri, title, pieceUri, { pdfUri, pdfPfls, wordUri, wordPfls, comment }) {
  const id = uuid();
  const uri = `${RESOURCE_BASE}parlementair-ingediend-stuk/${id}`;

  const queryString = `
${prefixHeaderLines.mu}
${prefixHeaderLines.parl}
${prefixHeaderLines.dct}
${prefixHeaderLines.schema}

INSERT DATA {
  GRAPH ${sparqlEscapeUri(VP_GRAPH_URI)} {
    ${sparqlEscapeUri(uri)}
      a parl:OpgehaaldStuk ;
      mu:uuid ${sparqlEscapeString(id)} ;
      dct:title ${sparqlEscapeString(title)} ;
      ${comment ? `schema:comment ${sparqlEscapeString(comment)} ;` : ''}
      ${pdfUri ? `parl:ongetekendBestand ${sparqlEscapeUri(pdfUri)} ;` : ''}
      ${pdfPfls ? `parl:ongetekendBestandId ${sparqlEscapeString(pdfPfls)} ;` : ''}
      ${wordUri ? `parl:wordBestand ${sparqlEscapeUri(wordUri)} ;` : ''}
      ${wordPfls ? `parl:wordBestandId ${sparqlEscapeString(wordPfls)} ;` : ''}
      parl:heeftOpgehaaldStuk ${sparqlEscapeUri(pieceUri)} .
    ${sparqlEscapeUri(retrievalActivityUri)} parl:opgehaaldStuk ${sparqlEscapeUri(uri)} .
  }
}`;
  await updateSudo(queryString);
}

/**
 * [QUERY]
 *
 * @param {string} parliamentFlow
 * @param {Piece[]} pieces
 * @returns {Promise<Piece[]>}
 */
async function enrichPiecesWithPreviousSubmissions(parliamentFlow, pieces) {
  const queryString = `
PREFIX parl: <http://mu.semte.ch/vocabularies/ext/parlement/>
PREFIX pav: <http://purl.org/pav/>

SELECT DISTINCT
?piece
?previousPdf ?previousPdfId
?previousWord ?previousWordId
?previousSigned ?previousSignedId
WHERE {
  { SELECT DISTINCT ?submissionActivity
    WHERE {
      VALUES ?parliamentFlow { ${sparqlEscapeUri(parliamentFlow)} }
      ?parliamentFlow parl:parlementaireProcedurestap ?parliamentSubcase .
      ?parliamentSubcase parl:parlementaireIndieningsactiviteiten ?submissionActivity
    } }

  VALUES ?piece {
    ${pieces.map((piece) =>sparqlEscapeUri(piece.uri)).join('\n    ')}
  }

  ?submissionActivity parl:ingediendStuk ?submittedPiece .
  {
    ?piece pav:previousVersion ?previousPiece .
    ?submittedPiece parl:heeftStuk ?previousPiece .
  }
  UNION
  {
    ?submittedPiece parl:heeftStuk ?piece .
  }

  OPTIONAL {
    ?submittedPiece parl:ongetekendBestand ?previousPdf ;
      parl:ongetekendBestandId ?previousPdfId .
  }
  OPTIONAL {
    ?submittedPiece parl:getekendBestand ?previousSigned ;
      parl:getekendBestandId ?previousSignedId .
  }
  OPTIONAL {
    ?submittedPiece parl:wordBestand ?previousWord ;
      parl:wordBestandId ?previousWordId .
  }
}`;

  const response = await query(queryString);
  const parsed = parseSparqlResults(response);
  parsed.forEach((row) => {
    const piece = pieces.find((piece) => piece.uri === row.piece);
    const pdfFile = piece.files.find((file) => file.isPdf);
    const wordFile = piece.files.find((file) => file.isWord);
    const signedFile = piece.files.find((file) => file.isSigned);

    if (pdfFile && row.previousPdf) {
      pdfFile.previousVersionUri = row.previousPdf;
      pdfFile.previousVersionParliamentId = row.previousPdfId;
    }

    if (wordFile && row.previousWord) {
      wordFile.previousVersionUri = row.previousWord;
      wordFile.previousVersionParliamentId = row.previousWordId;
    }

    if (signedFile && row.previousSigned) {
      signedFile.previousVersionUri = row.previousSigned;
      signedFile.previousVersionParliamentId = row.previousSignedId;
    }
  });

  return pieces;
}

async function createOrUpdateParliamentFlow(responseJson, decisionmakingFlowUri, pieces, currentUser, comment, isComplete) {
  const parliamentId = responseJson.pobj;
  pieces.forEach((piece) => {
    piece.files.forEach((file) => {
      const parliamentId = responseJson.files.find((r) => r.id === file.uri)?.pfls;
      if (parliamentId) {
        file.parliamentId = parliamentId;
      }
    });
  });

  let { parliamentFlow, parliamentSubcase } =
    await getParliamentFlowAndSubcase(decisionmakingFlowUri);

  parliamentFlow ??= await createParliamentFlow(
    parliamentId,
    decisionmakingFlowUri
  );
  parliamentSubcase ??= await createParliamentSubcase(parliamentFlow);

  const submissionActivity = await createSubmissionActivity(parliamentSubcase, currentUser, comment);
  await createSubmittedPieces(submissionActivity, pieces)

  await updateParliamentFlowStatus(
    { uri: parliamentFlow },
    isComplete
      ? PARLIAMENT_FLOW_STATUSES.COMPLETE
      : PARLIAMENT_FLOW_STATUSES.INCOMPLETE,
  );
}

/**
 * [SUDO QUERY]
 *
 * @param {string} pobj
 * @returns {Promise<Object>} Object containing a parliamentSubcase field
 */
async function getParliamentSubcaseFromPobj(pobj) {
  const queryString = `${prefixHeaderLines.parl}

SELECT DISTINCT ?parliamentSubcase
FROM ${sparqlEscapeUri(VP_GRAPH_URI)}
WHERE {
  ?parliamentFlow a parl:Parlementaireaangelegenheid ;
    parl:id ${sparqlEscapeString(pobj)} ;
    parl:parlementaireProcedurestap ?parliamentSubcase .
}`;
  const response = await querySudo(queryString);
  return parseSparqlResults(response)[0];
}

/**
 * [SUDO QUERY]
 *
 * @param {string} pobj
 * @returns {Promise<Object>} Object containing a subcase field
 */
async function getGeneratedSubcaseFromPobj(pobj) {
  const queryString = `${prefixHeaderLines.parl}
${prefixHeaderLines.prov}
${prefixHeaderLines.mu}
${prefixHeaderLines.dossier}

SELECT DISTINCT
  ?subcase ?subcaseId
  ?case ?caseId
  ?decisionmakingFlow ?decisionmakingFlowId
FROM ${sparqlEscapeUri(VP_GRAPH_URI)}
FROM ${sparqlEscapeUri(KANSELARIJ_GRAPH_URI)}
WHERE {
  ?parliamentFlow a parl:Parlementaireaangelegenheid ;
    parl:id ${sparqlEscapeString(pobj)} ;
    parl:parlementaireProcedurestap/parl:parlementaireOphalingsactiviteit/prov:generated ?subcase .
  ?subcase mu:uuid ?subcaseId .
  ?decisionmakingFlow dossier:doorloopt ?subcase ; mu:uuid ?decisionmakingFlowId .
  ?case dossier:Dossier.isNeerslagVan ?decisionmakingFlow ;
    mu:uuid ?caseId .
}`;
  const response = await querySudo(queryString);
  return parseSparqlResults(response)[0];
}

/**
 * [SUDO QUERY]
 *
 * @param {string} pobj
 * @returns {Promise<boolean>}
 */
async function pobjIsKnown(pobj) {
  const queryString = `
${prefixHeaderLines.parl}

ASK {
  GRAPH ${sparqlEscapeUri(VP_GRAPH_URI)} {
    ?parliamentFlow a parl:Parlementaireaangelegenheid ;
      parl:id ${sparqlEscapeString(pobj)} .
  }
}`;
  const response = await querySudo(queryString);
  return response?.boolean;
}

/**
 * [SUDO QUERY]
 *
 * @param {string} pobj
 * @returns {Promise<boolean>}
 */
async function pflsIsKnown(pfls) {
  const queryString = `
${prefixHeaderLines.parl}

ASK {
  VALUES ?parlId { parl:wordBestandId parl:ongetekendBestandId }
  GRAPH ${sparqlEscapeUri(VP_GRAPH_URI)} {
    ?retrievePiece a parl:OpgehaaldStuk;
      ?parlId ${sparqlEscapeString(pfls)} .
  }
}`;
  const response = await querySudo(queryString);
  return response?.boolean;
}

export {
  getParliamentFlowAndSubcase,
  getFlowsByStatus,
  createParliamentFlow,
  updateParliamentFlowStatus,
  createParliamentSubcase,
  createSubmissionActivity,
  createSubmittedPieces,
  enrichPiecesWithPreviousSubmissions,
  createOrUpdateParliamentFlow,
  createRetrievalActivity,
  createRetrievedPiece,
  pobjIsKnown,
  pflsIsKnown,
  getParliamentSubcaseFromPobj,
  getGeneratedSubcaseFromPobj,
};
