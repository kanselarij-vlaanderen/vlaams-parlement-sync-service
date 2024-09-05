import {
  uuid,
  sparqlEscapeUri,
  sparqlEscapeString,
  sparqlEscapeDateTime,
  sparqlEscapeInt,
  update,
} from 'mu';
import { querySudo, updateSudo } from '@lblod/mu-auth-sudo';
import {
  ACCESS_LEVELS,
  DECISION_RESULT_CODES,
  KANSELARIJ_GRAPH_URI,
  PUBLIC_GRAPH_URI,
  VP_GRAPH_URI
} from '../config';
import { prefixHeaderLines, RESOURCE_BASE } from "../constants";
import { parseSparqlResults } from './utils';
import fs from 'fs';

/**
 * Gets all needed properties of a list of piece URIs, and filters them
 * based on whether they were submitted already
 * @param {string[]} uris
 * @returns {Promise<Piece[]>}
 */
async function getPieceMetadata(uris) {
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
PREFIX parl: <http://mu.semte.ch/vocabularies/ext/parlement/>

SELECT DISTINCT
?id ?piece ?name ?created ?type ?typeLabel
?virtualFile ?format ?shareUri ?fileExtension
?isPdf ?isWord ?isSigned ?subcase ?subcaseName ?subcaseType ?subcaseCreated ?vertrouwelijkheidsniveau
WHERE {
  {
    SELECT ?id ?piece ?name ?created ?type ?virtualFile ?format ?shareUri ?fileExtension
    ?isPdf ?isWord ?isSigned ?subcase ?subcaseName ?subcaseType ?subcaseCreated ?vertrouwelijkheidsniveau
    WHERE {
      VALUES ?piece {
        ${uris.map(sparqlEscapeUri).join('\n    ')}
      }

      GRAPH ${sparqlEscapeUri(KANSELARIJ_GRAPH_URI)} {
        ?documentContainer dossier:Collectie.bestaatUit ?piece .
        ?documentContainer dct:type ?type .

        ?piece dct:title ?name ;
          mu:uuid ?id ;
          dct:created ?created ;
          besluitvorming:vertrouwelijkheidsniveau ?vertrouwelijkheidsniveau .
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

        OPTIONAL { ?virtualFile prov:hadPrimarySource ?sourceFile }
        OPTIONAL { ?derivedFile prov:hadPrimarySource ?virtualFile }

        BIND((!BOUND(?sourceFile) && !BOUND(?derivedFile) && !?isSigned) || (BOUND(?sourceFile) && !BOUND(?derivedFile) && !?isSigned) AS ?isPdf)
        BIND(BOUND(?derivedFile) AS ?isWord)

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
        OPTIONAL {
          ?subcase dct:type ?subcaseType .
        }
        OPTIONAL {
          ?subcase ext:procedurestapNaam ?subcaseName .
        }
      }
    }
  }

  GRAPH ${sparqlEscapeUri(VP_GRAPH_URI)} {
    FILTER NOT EXISTS { ?submittedPiece parl:ongetekendBestand ?virtualFile }
    FILTER NOT EXISTS { ?submittedPiece parl:wordBestand ?virtualFile }
    FILTER NOT EXISTS { ?submittedPiece parl:getekendBestand ?virtualFile }
  }

  GRAPH ${sparqlEscapeUri(PUBLIC_GRAPH_URI)} {
    ?type skos:altLabel ?typeLabel .
  }
}
ORDER BY DESC(?subcaseCreated) STR(?name)`;
  const response = await querySudo(queryString);
  if (!response?.results?.bindings) {
    return null;
  }

  const bindings = response.results.bindings;
  const pieceMap = bindings.reduce(
    (map, binding) => {
      const uri = binding.piece.value;
      const piece = map.get(uri) ?? {};

      piece.uri = uri;
      piece.id = binding.id.value;
      piece.name = binding.name.value;
      piece.subcase = binding.subcase.value;
      piece.subcaseName = binding.subcaseName?.value;
      piece.subcaseType = binding.subcaseType?.value;
      piece.subcaseCreated = binding.subcaseCreated?.value;
      piece.created = new Date(binding.created.value);
      piece.accessLevel = binding.vertrouwelijkheidsniveau?.value;
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
        isPdf: binding.isPdf?.value === "1",
        isWord: binding.isWord?.value === "1",
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

/**
 * Gets all metadata for pieces that have already been submitted
 * @param {string[]} uris
 * @returns {Promise<Piece[]>}
 */
async function getSubmittedPieces(uris) {
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
PREFIX parl: <http://mu.semte.ch/vocabularies/ext/parlement/>

SELECT DISTINCT
?id ?piece ?name ?created ?type ?typeLabel
?virtualFile ?format ?shareUri ?fileExtension
?isPdf ?isWord ?isSigned ?subcase ?subcaseName ?subcaseType ?subcaseCreated
WHERE {
  {
    SELECT ?id ?piece ?name ?created ?type ?virtualFile ?format ?shareUri ?fileExtension
    ?isPdf ?isWord ?isSigned ?subcase ?subcaseName ?subcaseType ?subcaseCreated
    WHERE {
      VALUES ?piece {
        ${uris.map(sparqlEscapeUri).join('\n    ')}
      }
      GRAPH ${sparqlEscapeUri(KANSELARIJ_GRAPH_URI)} {
        ?documentContainer dossier:Collectie.bestaatUit ?piece .
        ?documentContainer dct:type ?type .

        ?piece dct:title ?name ;
          mu:uuid ?id ;
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

        OPTIONAL { ?virtualFile prov:hadPrimarySource ?sourceFile }
        OPTIONAL { ?derivedFile prov:hadPrimarySource ?virtualFile }

        BIND((!BOUND(?sourceFile) && !BOUND(?derivedFile) && !?isSigned) || (BOUND(?sourceFile) && !BOUND(?derivedFile) && !?isSigned) AS ?isPdf)
        BIND(BOUND(?derivedFile) AS ?isWord)

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
        OPTIONAL {
          ?subcase dct:type ?subcaseType .
        }
        OPTIONAL {
          ?subcase ext:procedurestapNaam ?subcaseName .
        }
      }
    }
  }

  GRAPH ${sparqlEscapeUri(VP_GRAPH_URI)} {
    { ?submittedPiece parl:ongetekendBestand ?virtualFile }
    UNION
    { ?submittedPiece parl:wordBestand ?virtualFile }
    UNION
    { ?submittedPiece parl:getekendBestand ?virtualFile }
  }

  GRAPH ${sparqlEscapeUri(PUBLIC_GRAPH_URI)} {
    ?type skos:altLabel ?typeLabel .
  }
}
ORDER BY DESC(?subcaseCreated) STR(?name)`;
  const response = await querySudo(queryString);
  if (!response?.results?.bindings) {
    return [];
  }

  const bindings = response.results.bindings;
  const pieceMap = bindings.reduce(
    (map, binding) => {
      const uri = binding.piece.value;
      const piece = map.get(uri) ?? {};

      piece.uri = uri;
      piece.id = binding.id.value;
      piece.name = binding.name.value;
      piece.subcase = binding.subcase.value;
      piece.subcaseName = binding.subcaseName?.value;
      piece.subcaseType = binding.subcaseType?.value;
      piece.subcaseCreated = binding.subcaseCreated?.value;
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
        isPdf: binding.isPdf?.value === "1",
        isWord: binding.isWord?.value === "1",
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

async function pieceIsOnFinalMeeting(pieceUri) {
  const queryString = `${prefixHeaderLines.dct}
${prefixHeaderLines.besluitvorming}

ASK {
  ?agendaitem besluitvorming:geagendeerdStuk ${sparqlEscapeUri(pieceUri)} ;
    ^dct:subject ?treatment ;
    ^dct:hasPart ?agenda .
  ?treatment besluitvorming:heeftBeslissing ?decisionActivity .
  ?decisionActivity besluitvorming:resultaat ${sparqlEscapeUri(DECISION_RESULT_CODES.GOEDGEKEURD)} .
  ?meeting besluitvorming:behandelt ?agenda .
}`;
  const response = await querySudo(queryString);
  return response?.boolean;
}

/**
 * [QUERY SUDO]
 */
async function getPieceFromFile(fileUri) {
  const queryString = `${prefixHeaderLines.prov}

SELECT DISTINCT ?piece
FROM ${sparqlEscapeUri(KANSELARIJ_GRAPH_URI)}
WHERE {
  { ?piece prov:value ${sparqlEscapeUri(fileUri)} }
  UNION
  { ?piece prov:value/^prov:hadPrimarySource ${sparqlEscapeUri(fileUri)} }
}`;
  const response = await querySudo(queryString);
  const parsed = parseSparqlResults(response)[0];
  return parsed.piece;
}

/**
 * [SUDO QUERY]
 */
async function fileIsKnown(file) {
  const queryString = `
${prefixHeaderLines.nfo}

ASK {
  GRAPH ${sparqlEscapeUri(KANSELARIJ_GRAPH_URI)} { ${sparqlEscapeUri(file)} a nfo:FileDataObject . }
}`;
  const response = await querySudo(queryString);
  return response?.boolean;
}

/**
 * [SUDO QUERY]
 */
async function deleteFile(fileUri, isSudo) {
  const queryString = `${prefixHeaderLines.nie}

SELECT DISTINCT ?physicalFile
FROM ${sparqlEscapeUri(KANSELARIJ_GRAPH_URI)}
WHERE {
  ?physicalFile nie:dataSource ${sparqlEscapeUri(fileUri)} .
}`;
  const response = await querySudo(queryString);
  const { physicalFile } = parseSparqlResults(response)[0];
  fs.unlinkSync(physicalFile.replace('share://', '/share/'));

  const updateString = `${prefixHeaderLines.mu}
${prefixHeaderLines.nfo}
${prefixHeaderLines.nie}
${prefixHeaderLines.dct}
${prefixHeaderLines.dbpedia}
${prefixHeaderLines.prov}

DELETE WHERE {
  GRAPH ${sparqlEscapeUri(KANSELARIJ_GRAPH_URI)} {
    ?derived prov:hadPrimarySource ${sparqlEscapeUri(fileUri)} .
    ${sparqlEscapeUri(fileUri)} a nfo:FileDataObject ;
      mu:uuid ?id ;
      nfo:fileName ?fileName ;
      dct:format ?format ;
      nfo:fileSize ?fileSize ;
      dbpedia:fileExtension ?fileExtension ;
      dct:created ?created ;
      dct:modified ?modified ;
      prov:hadPrimarySource ?source .

    ${sparqlEscapeUri(physicalFile)} a nfo:FileDataObject ;
      nie:dataSource ${sparqlEscapeUri(fileUri)} ;
      mu:uuid ?pid ;
      nfo:fileName ?pfileName ;
      dct:format ?pformat ;
      nfo:fileSize ?pfileSize ;
      dbpedia:fileExtension ?pfileExtension ;
      dct:created ?pcreated ;
      dct:modified ?pmodified .
  }
}`;
  const updateFunc = isSudo ? updateSudo : update;
  await updateFunc(updateString);
}

/**
 * [SUDO QUERY]
 */
async function createDocumentContainerAndPiece(title, documentType, accessLevel=ACCESS_LEVELS.INTERN_OVERHEID, isSudo) {
  const now = new Date();

  const documentContainerId = uuid();
  const documentContainerUri = `${RESOURCE_BASE}serie/${documentContainerId}`;

  const pieceId = uuid();
  const pieceUri = `${RESOURCE_BASE}stuk/${pieceId}`;

  const queryString = `${prefixHeaderLines.mu}
${prefixHeaderLines.dossier}
${prefixHeaderLines.besluitvorming}
${prefixHeaderLines.dct}

INSERT DATA {
  GRAPH ${sparqlEscapeUri(KANSELARIJ_GRAPH_URI)} {
    ${sparqlEscapeUri(documentContainerUri)} a dossier:Serie ;
      mu:uuid ${sparqlEscapeString(documentContainerId)} ;
      dct:created ${sparqlEscapeDateTime(now)} ;
      ${documentType ? `dct:type ${sparqlEscapeUri(documentType)} ;` : ''}
      dossier:Collectie.bestaatUit ${sparqlEscapeUri(pieceUri)} .

    ${sparqlEscapeUri(pieceUri)} a dossier:Stuk ;
      mu:uuid ${sparqlEscapeString(pieceId)} ;
      dct:title ${sparqlEscapeString(title)} ;
      dct:created ${sparqlEscapeDateTime(now)} ;
      besluitvorming:vertrouwelijkheidsniveau ${sparqlEscapeUri(accessLevel)} .
  }
}`;
  const updateFunc = isSudo ? updateSudo : update;
  await updateFunc(queryString);
  return { documentContainerUri, pieceUri };
}

/**
 * [SUDO QUERY]
 */
async function createFile(filePath, fileName, fileSize, extension, mimeType, isSudo) {
  const now = new Date();

  const fileId = uuid();
  const fileUri = `${RESOURCE_BASE}bestand/${fileId}`;

  const physicalFileId = uuid();
  const physicalFileUri = filePath.replace('/share/', 'share://');

  const queryString = `${prefixHeaderLines.mu}
${prefixHeaderLines.nfo}
${prefixHeaderLines.nie}
${prefixHeaderLines.dct}
${prefixHeaderLines.dbpedia}

INSERT DATA {
  GRAPH ${sparqlEscapeUri(KANSELARIJ_GRAPH_URI)} {
    ${sparqlEscapeUri(fileUri)} a nfo:FileDataObject ;
      mu:uuid ${sparqlEscapeString(fileId)} ;
      nfo:fileName ${sparqlEscapeString(fileName)} ;
      dct:format ${sparqlEscapeString(mimeType)} ;
      nfo:fileSize ${sparqlEscapeInt(fileSize)} ;
      dbpedia:fileExtension ${sparqlEscapeString(extension)} ;
      dct:created ${sparqlEscapeDateTime(now)} ;
      dct:modified ${sparqlEscapeDateTime(now)} .

    ${sparqlEscapeUri(physicalFileUri)} a nfo:FileDataObject ;
      mu:uuid ${sparqlEscapeString(physicalFileId)} ;
      nie:dataSource ${sparqlEscapeUri(fileUri)} ;
      nfo:fileName ${sparqlEscapeString(fileName)} ;
      dct:format ${sparqlEscapeString(mimeType)} ;
      nfo:fileSize ${sparqlEscapeInt(fileSize)} ;
      dbpedia:fileExtension ${sparqlEscapeString(extension)} ;
      dct:created ${sparqlEscapeDateTime(now)} ;
      dct:modified ${sparqlEscapeDateTime(now)} .
  }
}`;
  const updateFunc = isSudo ? updateSudo : update;
  await updateFunc(queryString);
  return fileUri;
}

/**
 * [SUDO QUERY]
 */
async function linkFileToPiece(fileUri, pieceUri, isSudo) {
  const queryString = `${prefixHeaderLines.prov}

INSERT DATA {
  GRAPH ${sparqlEscapeUri(KANSELARIJ_GRAPH_URI)} {
    ${sparqlEscapeUri(pieceUri)} prov:value ${sparqlEscapeUri(fileUri)} .
  }
}`;
  const updateFunc = isSudo ? updateSudo : update;
  await updateFunc(queryString);
}

/**
 * [SUDO QUERY]
 */
async function linkDerivedFileToSourceFile(derivedUri, sourceUri, isSudo) {
  const queryString = `${prefixHeaderLines.prov}

INSERT DATA {
  GRAPH ${sparqlEscapeUri(KANSELARIJ_GRAPH_URI)} {
    ${sparqlEscapeUri(derivedUri)} prov:hadPrimarySource ${sparqlEscapeUri(sourceUri)} .
  }
}`;
  const updateFunc = isSudo ? updateSudo : update;
  await updateFunc(queryString);
}

/**
 * [SUDO QUERY]
 */
async function moveDerivedAndSourceLinks(oldFileUri, newFileUri, isSudo) {
  const queryString = `${prefixHeaderLines.prov}

SELECT DISTINCT ?source ?derived
FROM ${sparqlEscapeUri(KANSELARIJ_GRAPH_URI)}
WHERE {
  OPTIONAL { ${sparqlEscapeUri(oldFileUri)} prov:hadPrimarySource ?source }
  OPTIONAL { ?derived prov:hadPrimarySource ${sparqlEscapeUri(oldFileUri)} }
}`;
  const response = await querySudo(queryString);
  const { source, derived } = parseSparqlResults(response)[0];

  const updateFunc = isSudo ? updateSudo : update;
  if (source) {
    const deleteString = `${prefixHeaderLines.prov}

  DELETE WHERE {
    GRAPH ${sparqlEscapeUri(KANSELARIJ_GRAPH_URI)} {
      ?oldDerivedFile prov:hadPrimarySource ${sparqlEscapeUri(source)} .
    }
  }`;
    await updateFunc(deleteString);

    const updateString = `${prefixHeaderLines.prov}

  INSERT DATA {
    GRAPH ${sparqlEscapeUri(KANSELARIJ_GRAPH_URI)} {
      ${sparqlEscapeUri(newFileUri)} prov:hadPrimarySource ${sparqlEscapeUri(source)} .
    }
  }`;
    await updateFunc(updateString);
  }
  if (derived) {
    const deleteString = `${prefixHeaderLines.prov}

  DELETE WHERE {
    GRAPH ${sparqlEscapeUri(KANSELARIJ_GRAPH_URI)} {
      ${sparqlEscapeUri(derived)} prov:hadPrimarySource ?oldSourceFile .
    }
  }`;
    await updateFunc(deleteString);

    const updateString = `${prefixHeaderLines.prov}

  INSERT DATA {
    GRAPH ${sparqlEscapeUri(KANSELARIJ_GRAPH_URI)} {
      ${sparqlEscapeUri(derived)} prov:hadPrimarySource ${sparqlEscapeUri(newFileUri)} .
    }
  }`;
    await updateFunc(updateString);
  }
}

function filterRedundantFiles(pieces, submitted) {
  for (const piece of pieces) {
    const submittedPiece = submitted.find((p) => {
      return p.id === piece.id;
    });
    piece.files = piece.files.filter((file) => {
      return !file.isPdf ||
        !(piece.files.some((file) => file.isSigned) ||
          (submittedPiece && submittedPiece.files.some((file) => file.isSigned))
        )
    });
  }
  return pieces.filter((piece) => { return piece.files?.length > 0; });
}

export {
  getPieceMetadata,
  getSubmittedPieces,
  fileIsKnown,
  getPieceFromFile,
  pieceIsOnFinalMeeting,
  createDocumentContainerAndPiece,
  createFile,
  linkFileToPiece,
  linkDerivedFileToSourceFile,
  moveDerivedAndSourceLinks,
  deleteFile,
  filterRedundantFiles
}
