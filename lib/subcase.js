import { parseSparqlResults } from "./utils";
import { query, sparqlEscapeUri } from "mu";

async function getSubmitterForSubcase(subcaseUri) {
  const queryString = `
    PREFIX dct: <http://purl.org/dc/terms/>
    PREFIX ext: <http://mu.semte.ch/vocabularies/ext/>
    PREFIX mandaat: <http://data.vlaanderen.be/ns/mandaat#>
    PREFIX persoon: <https://data.vlaanderen.be/ns/persoon#>
    PREFIX foaf: <http://xmlns.com/foaf/0.1/>

    SELECT ?title ?firstName ?lastName WHERE {
      ${sparqlEscapeUri(subcaseUri)} ext:indiener ?mandatee .
      ?mandatee dct:title ?title .
      ?mandatee mandaat:isBestuurlijkeAliasVan ?person .
      ?person persoon:gebruikteVoornaam ?firstName .
      ?person foaf:familyName ?lastName .
    } LIMIT 1
  `;
  const bindings = await query(queryString);
  const parsed = parseSparqlResults(bindings);
  return parsed ? parsed[0] : null;
}

export { getSubmitterForSubcase };
