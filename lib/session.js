import { query, sparqlEscapeUri } from 'mu';

async function sessionHasRole(sessionUri, roleUris) {
  if (!roleUris || roleUris.length === 0)
    return false;

  const queryString = `PREFIX session: <http://mu.semte.ch/vocabularies/session/>
PREFIX ext: <http://mu.semte.ch/vocabularies/ext/>
PREFIX org: <http://www.w3.org/ns/org#>

ASK {
  VALUES (?roleUri) {
    ${roleUris.map(uri => `(${sparqlEscapeUri(uri)})`).join(`
    `)}
  }

  ${sparqlEscapeUri(sessionUri)} session:account ?account ;
    ext:sessionMembership / org:role ?roleUri .
}`;
  const response = await query(queryString);
  return response.boolean;
}

export {
  sessionHasRole,
}
