import {
  query,
  sparqlEscapeUri,
} from "mu";
import { DOCUMENT_TYPES, SUBCASE_TYPES } from '../config';

async function fetchCurrentUser(sessionUri) {
  // Note: mock accounts are in the http://mu.semte.ch/graphs/public graph, whereas regular accounts are in the http://mu.semte.ch/graphs/system/users graph.
  const userQuery = `
PREFIX session: <http://mu.semte.ch/vocabularies/session/>
PREFIX org: <http://www.w3.org/ns/org#>
PREFIX foaf: <http://xmlns.com/foaf/0.1/>

SELECT DISTINCT ?user WHERE {
  GRAPH <http://mu.semte.ch/graphs/sessions> {
    ${sparqlEscapeUri(sessionUri)} session:account ?account
  }
  VALUES ?g { <http://mu.semte.ch/graphs/public> <http://mu.semte.ch/graphs/system/users> }
  GRAPH ?g {
    ?user foaf:account ?account .
    ?membership org:member ?user .
  }
}`;
  const currentUser = await query(userQuery);
  if (currentUser) {
    let parsedResults = parseSparqlResults(currentUser);
    return parsedResults?.[0]?.user;
  }
}

/* Execute these on startup so we don't need to run the query each time */
const documentTypes = {};
fetchDocumentTypes();

async function fetchDocumentTypes () {
  for (const docType in DOCUMENT_TYPES) {
    if (DOCUMENT_TYPES.hasOwnProperty(docType)) {
      documentTypes[DOCUMENT_TYPES[docType]] = await getDocumentType(
        DOCUMENT_TYPES[docType]
      );
    }
  }
}
/**
* Gets the metadata for a document type, such as the label
*/
async function getDocumentType(uri) {
  if (documentTypes[uri]) {
    return documentTypes[uri];
  }
  const queryString = `
  PREFIX skos: <http://www.w3.org/2004/02/skos/core#>
  SELECT DISTINCT ?uri ?label ?altLabel
  WHERE {
    VALUES ?uri {
      ${sparqlEscapeUri(uri)}
    }
    ?uri skos:prefLabel ?label;
         skos:altLabel ?altLabel .
  }
  `;
    const response = await query(queryString);
    const parsed = parseSparqlResults(response)?.[0];
    if (!documentTypes[uri]) {
      documentTypes[uri] = parsed;
    }
    return parsed ?? { uri, label: null, altLabel: null };
};

/* Execute these on startup so we don't need to run the query each time */
const subcaseTypes = {};
fetchSubcaseTypes();

async function fetchSubcaseTypes () {
  for (const subcaseType in SUBCASE_TYPES) {
    if (SUBCASE_TYPES.hasOwnProperty(subcaseType)) {
      subcaseTypes[SUBCASE_TYPES[subcaseType]] = await getSubcaseType(
        SUBCASE_TYPES[subcaseType]
      );
    }
  }
}
/**
* Gets the metadata for a subcase type, such as the label
*/
async function getSubcaseType(uri) {
  if (subcaseTypes[uri]) {
    return subcaseTypes[uri];
  }
  const queryString = `
  PREFIX skos: <http://www.w3.org/2004/02/skos/core#>
  SELECT DISTINCT ?uri ?label
  WHERE {
    VALUES ?uri {
      ${sparqlEscapeUri(uri)}
    }
    ?uri skos:prefLabel ?label .
  }
  `;
    const response = await query(queryString);
    const parsed = parseSparqlResults(response)?.[0];
    if (!subcaseTypes[uri]) {
      subcaseTypes[uri] = parsed;
    }
    return parsed ?? { uri, label: null };
};

const groupBySubcase = (pieces) => {
  let subcaseObject = {
  };
  for (const piece of pieces) {
    if (!subcaseObject[piece.subcase]) {
      subcaseObject[piece.subcase] = {
        subcaseType: piece.subcaseType,
        subcaseName: piece.subcaseName,
        pieces: []
      };
    }
    subcaseObject[piece.subcase].pieces.push(piece);
  }
  return subcaseObject;
};

const parseSparqlResults = (data) => {
  if (!data) return null;
  const vars = data.head.vars;
  return data.results.bindings.map((binding) => {
    const obj = {};
    vars.forEach((varKey) => {
      if (binding[varKey]) {
        obj[varKey] = binding[varKey].value;
      }
    });
    return obj;
  });
};

export {
  parseSparqlResults,
  fetchCurrentUser,
  getDocumentType,
  getSubcaseType,
  groupBySubcase
};
