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
import { PARLIAMENT_FLOW_STATUSES } from "../config";

const RESOURCE_BASE = "http://themis.vlaanderen.be/id/";

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
  return parsed ?? { parliamentFlow: null, parliamentSubcase: null };
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
  ${sparqlEscapeUri(parliamentFlowUri)}
    a parl:Parlementaireaangelegenheid ;
    mu:uuid ${sparqlEscapeString(id)} ;
    adms:status ${sparqlEscapeUri(PARLIAMENT_FLOW_STATUSES.INCOMPLETE)} ;
    dossier:openingsdatum ${sparqlEscapeDate(new Date())} ;
    parl:id ${sparqlEscapeString(parliamentId)} .
  ${sparqlEscapeUri(parliamentFlowUri)} parl:behandeltDossier ?case .
} WHERE {
  ?case dossier:Dossier.isNeerslagVan ${sparqlEscapeUri(
    decisionmakingFlowUri
  )} .
}`;
  await update(queryString);

  return parliamentFlowUri;
}

/**
 * @param {string} parliamentFlowUri
 * @param {string} statusUri
 */
async function updateParliamentFlowStatus(parliamentFlowUri, statusUri) {
  const queryString = `
PREFIX dossier: <https://data.vlaanderen.be/ns/dossier#>
PREFIX parl: <http://mu.semte.ch/vocabularies/ext/parlement/>
PREFIX xsd: <http://www.w3.org/2001/XMLSchema#>
PREFIX mu: <http://mu.semte.ch/vocabularies/core/>
PREFIX adms: <http://www.w3.org/ns/adms#>

DELETE {
  ${sparqlEscapeUri(parliamentFlowUri)} adms:status ?oldStatus .
}
INSERT {
  ${sparqlEscapeUri(parliamentFlowUri)} adms:status ${sparqlEscapeUri(statusUri)} .
} WHERE {
  ${sparqlEscapeUri(parliamentFlowUri)} adms:status ?oldStatus .
}`;
  await update(queryString);
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

/**
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
    const subcaseName_ = sparqlEscapeString(subcaseName);
    const subcaseCreated_ = sparqlEscapeDateTime(subcaseCreated);
    
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
    parliamentFlow,
    isComplete
      ? PARLIAMENT_FLOW_STATUSES.COMPLETE
      : PARLIAMENT_FLOW_STATUSES.INCOMPLETE,
  );
}

export {
  getParliamentFlowAndSubcase,
  createParliamentFlow,
  updateParliamentFlowStatus,
  createParliamentSubcase,
  createSubmissionActivity,
  createSubmittedPieces,
  enrichPiecesWithPreviousSubmissions,
  createOrUpdateParliamentFlow
};
