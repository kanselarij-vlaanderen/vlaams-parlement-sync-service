import {
  query,
  update,
  sparqlEscapeUri,
  sparqlEscapeDate,
  sparqlEscapeDateTime,
  sparqlEscapeString,
  uuid,
} from "mu";

import { querySudo, updateSudo } from "@lblod/mu-auth-sudo";

import { parseSparqlResults } from "./utils";
import {
  PARLIAMENT_FLOW_STATUSES,
  VP_GRAPH_URI,
  KANSELARIJ_GRAPH_URI,
} from "../config";

const RESOURCE_BASE = "http://themis.vlaanderen.be/id/";

/**
 * @param {string} decisionmakingFlowUri
 * @returns {Promise<{parliamentFlow: ?string, parliamentSubcase: ?string}>}
 */
async function getParliamentFlowAndSubcase(decisionmakingFlowUri) {
  const queryString = `
PREFIX dossier: <https://data.vlaanderen.be/ns/dossier#>
PREFIX parl: <http://mu.semte.ch/vocabularies/ext/parlement/>

SELECT DISTINCT ?parliamentFlow ?parliamentSubcase
FROM ${sparqlEscapeUri(KANSELARIJ_GRAPH_URI)}
FROM ${sparqlEscapeUri(VP_GRAPH_URI)}
WHERE {
  VALUES ?decisionmakingFlow {
    ${sparqlEscapeUri(decisionmakingFlowUri)}
  }
  ?case dossier:Dossier.isNeerslagVan ?decisionmakingFlow .
  ?parliamentFlow parl:behandeltDossier ?case .
  ?parliamentFlow parl:parlementaireProcedurestap ?parliamentSubcase .
}`;
  const response = await querySudo(queryString);
  const parsed = parseSparqlResults(response)?.[0];
  return {
    parliamentFlow: null,
    parliamentSubcase: null,
    ...parsed
  };
}

/**
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
 * @param {string} uri
 * @returns {Promise<string>} The uri of the parliamentary flow
 */
async function createParliamentFlow(parliamentId, decisionmakingFlowUri) {
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
      adms:status ${sparqlEscapeUri(PARLIAMENT_FLOW_STATUSES.INCOMPLETE)} ;
      dossier:openingsdatum ${sparqlEscapeDate(new Date())} ;
      parl:id ${sparqlEscapeString(parliamentId)} .
    ${sparqlEscapeUri(parliamentFlowUri)} parl:behandeltDossier ?case .
  }
} WHERE {
  GRAPH ${sparqlEscapeUri(KANSELARIJ_GRAPH_URI)} {
    ?case dossier:Dossier.isNeerslagVan ${sparqlEscapeUri(
      decisionmakingFlowUri
    )} .
  }
}`;
  await updateSudo(queryString);

  return parliamentFlowUri;
}

/**
 * @param {string} parliamentFlowUri
 * @param {string} statusUri
 * @param {boolean} updateSudo
 */
async function updateParliamentFlowStatus(parliamentFlowUri, statusUri, isSudo=false) {
  const queryString = `
PREFIX dossier: <https://data.vlaanderen.be/ns/dossier#>
PREFIX parl: <http://mu.semte.ch/vocabularies/ext/parlement/>
PREFIX xsd: <http://www.w3.org/2001/XMLSchema#>
PREFIX mu: <http://mu.semte.ch/vocabularies/core/>
PREFIX adms: <http://www.w3.org/ns/adms#>

DELETE {
  GRAPH ${sparqlEscapeUri(VP_GRAPH_URI)} {
    ${sparqlEscapeUri(parliamentFlowUri)} adms:status ?oldStatus .
  }
}
INSERT {
  GRAPH ${sparqlEscapeUri(VP_GRAPH_URI)} {
    ${sparqlEscapeUri(parliamentFlowUri)} adms:status ${sparqlEscapeUri(statusUri)} .
  }
} WHERE {
  GRAPH ${sparqlEscapeUri(VP_GRAPH_URI)} {
    ${sparqlEscapeUri(parliamentFlowUri)} adms:status ?oldStatus .
  }
}`;
  const updateFunc = isSudo ? updateSudo : update;
  await updateFunc(queryString);
}

/**
 * @param {string} uri
 * @returns {Promise<string>} The uri of the parliamentary subcase
 */
async function createParliamentSubcase(parliamentFlowUri) {
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
  await updateSudo(queryString);

  return uri;
}

/**
 * @param {string} subcaseUri
 * @param {string} userUri
 * @returns {Promise<string>} The uri of the parliamentary submission activity
 */
async function createSubmissionActivity(subcaseUri, userUri, comment) {
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
  GRAPH ${sparqlEscapeUri(VP_GRAPH_URI)} {
    ${sparqlEscapeUri(uri)}
      a parl:ParlementaireIndieningsactiviteit ;
      mu:uuid ${sparqlEscapeString(id)} ;
      dct:description ${sparqlEscapeString(comment)} ;
      dossier:Procedurestap.startdatum ${sparqlEscapeDateTime(new Date())} ;
      prov:wasAssociatedWith ${sparqlEscapeUri(userUri)} .
    ${sparqlEscapeUri(subcaseUri)} parl:parlementaireIndieningsactiviteiten ${sparqlEscapeUri(uri)} .
  }
}`;
  await updateSudo(queryString);

  return uri;
}

/**
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
  GRAPH ${sparqlEscapeUri(VP_GRAPH_URI)} {
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
  }
} WHERE {
  VALUES
  (?submittedPiece ?id ?piece ?name ?subcaseName ?subcaseCreated ?unsignedFile ?unsignedFileParliamentId ?signedFile ?signedFileParliamentId ?wordFile ?wordFileParliamentId)
  {
    ${values.join('\n    ')}
  }
}`;
  await updateSudo(queryString);
}

/**
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
FROM ${sparqlEscapeUri(VP_GRAPH_URI)}
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

  const response = await querySudo(queryString);
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

async function createOrUpdateParliamentFlow(responseJson, decisionmakingFlowUri, pieces, userUri, comment, isComplete) {

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

  const submissionActivity = await createSubmissionActivity(
    parliamentSubcase,
    userUri,
    comment
  );
  await createSubmittedPieces(submissionActivity, pieces)

  await updateParliamentFlowStatus(
    parliamentFlow,
    isComplete
      ? PARLIAMENT_FLOW_STATUSES.COMPLETE
      : PARLIAMENT_FLOW_STATUSES.INCOMPLETE,
    true // updateSudo
  );
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
  createOrUpdateParliamentFlow
};
