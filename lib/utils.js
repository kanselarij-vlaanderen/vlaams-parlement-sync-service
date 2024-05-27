import {
  query,
  sparqlEscapeUri,
} from "mu";
import { querySudo } from "@lblod/mu-auth-sudo";
import { DOCUMENT_TYPES, SUBCASE_TYPES } from '../config';
import { escapedGraphs, prefixHeaderLines } from "../constants";

async function fetchCurrentUser(sessionUri) {
  // Note: mock accounts are in the http://mu.semte.ch/graphs/public graph, whereas regular accounts are in the http://mu.semte.ch/graphs/system/users graph.
  const userQuery = `
${prefixHeaderLines.foaf}
${prefixHeaderLines.session}

SELECT DISTINCT ?uri ?firstName ?familyName ?mbox WHERE {
  GRAPH ${escapedGraphs.sessions} {
    ${sparqlEscapeUri(sessionUri)} session:account ?account
  }
  VALUES ?g { <http://mu.semte.ch/graphs/public> <http://mu.semte.ch/graphs/system/users> }
  GRAPH ?g {
    ?uri foaf:account ?account ;
          foaf:firstName ?firstName ;
          foaf:familyName ?familyName ;
          foaf:mbox ?mbox .
  }
}`;
  const currentUser = await query(userQuery);
  if (currentUser) {
    let parsedResults = parseSparqlResults(currentUser);
    return parsedResults?.[0];
  }
}

async function fetchUser(userUri) {
  // Note: mock accounts are in the http://mu.semte.ch/graphs/public graph, whereas regular accounts are in the http://mu.semte.ch/graphs/system/users graph.
  const userQuery = `
${prefixHeaderLines.foaf}

SELECT DISTINCT ?uri ?firstName ?familyName ?mbox WHERE {
  VALUES ?g { <http://mu.semte.ch/graphs/public> <http://mu.semte.ch/graphs/system/users> }
  VALUES ?uri { ${sparqlEscapeUri(userUri)} }
  GRAPH ?g {
    ?user foaf:account ?account ;
          foaf:firstName ?firstName ;
          foaf:familyName ?familyName ;
          foaf:mbox ?mbox .
  }
}`;
  const user = await querySudo(userQuery);
  if (user) {
    let parsedResults = parseSparqlResults(user);
    return parsedResults?.[0];
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
  ${prefixHeaderLines.skos}
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
  ${prefixHeaderLines.skos}
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
  fetchUser,
  getDocumentType,
  getSubcaseType,
  groupBySubcase
};
