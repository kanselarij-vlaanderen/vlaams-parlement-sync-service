import { sparqlEscapeUri } from "mu";
import { VP_GRAPH_URI, KANSELARIJ_GRAPH_URI, EMAIL_GRAPH_URI } from "./config";

const RESOURCE_BASE = "http://themis.vlaanderen.be/id/";

const prefixes = {
  adms: "http://www.w3.org/ns/adms#",
  besluitvorming: "https://data.vlaanderen.be/ns/besluitvorming#",
  dbpedia: "http://dbpedia.org/ontology/",
  dct: "http://purl.org/dc/terms/",
  dossier: "https://data.vlaanderen.be/ns/dossier#",
  ext: "http://mu.semte.ch/vocabularies/ext/",
  mu: "http://mu.semte.ch/vocabularies/core/",
  nfo: "http://www.semanticdesktop.org/ontologies/2007/03/22/nfo#",
  nie: "http://www.semanticdesktop.org/ontologies/2007/01/19/nie#",
  nmo: "http://www.semanticdesktop.org/ontologies/2007/03/22/nmo#",
  parl: "http://mu.semte.ch/vocabularies/ext/parlement/",
  pav: "http://purl.org/pav/",
  prov: "http://www.w3.org/ns/prov#",
  schema: "http://schema.org/",
  sign: "http://mu.semte.ch/vocabularies/ext/handtekenen/",
  skos: "http://www.w3.org/2004/02/skos/core#",
};

const prefixHeaderLines = Object.fromEntries(
  Object.entries(prefixes).map(([key, value]) => [
    key,
    `PREFIX ${key}: ${sparqlEscapeUri(value)}`,
  ])
);

const graphs = {
  kanselarij: { uri: KANSELARIJ_GRAPH_URI },
  email: { uri: EMAIL_GRAPH_URI },
  parliament: { uri: VP_GRAPH_URI },
};

const escapedGraphs = Object.fromEntries(
  Object.entries(graphs).map(([graphName, { uri }]) => [
    graphName,
    sparqlEscapeUri(uri),
  ])
);

export { prefixHeaderLines, RESOURCE_BASE, escapedGraphs };
