import {
  query,
  sparqlEscapeUri,
} from "mu";

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

export { parseSparqlResults, fetchCurrentUser };
