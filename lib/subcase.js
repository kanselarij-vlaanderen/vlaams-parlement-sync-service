import { parseSparqlResults } from "./utils";
import { query, sparqlEscapeUri } from "mu";
import { prefixHeaderLines } from "../constants";

async function getSubmitterForSubcase(subcaseUri) {
  const queryString = `
    ${prefixHeaderLines.dct}
    ${prefixHeaderLines.ext}
    ${prefixHeaderLines.foaf}
    ${prefixHeaderLines.mandaat}
    ${prefixHeaderLines.persoon}

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
