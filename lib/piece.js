import { query, sparqlEscapeUri } from 'mu';
import { querySudo } from '@lblod/mu-auth-sudo';
import { KANSELARIJ_GRAPH_URI, PUBLIC_GRAPH_URI, VP_GRAPH_URI } from '../config';

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
    OPTIONAL { ?submittedPiece parl:ongetekendBestand ?virtualFile }
    OPTIONAL { ?submittedPiece parl:wordBestand ?virtualFile }
    OPTIONAL { ?submittedPiece parl:getekendBestand ?virtualFile }
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
  filterRedundantFiles
}
