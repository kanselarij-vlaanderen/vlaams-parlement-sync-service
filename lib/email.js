import { uuid, sparqlEscapeUri, sparqlEscapeString } from 'mu';
import { updateSudo } from '@lblod/mu-auth-sudo';
import { EMAIL_GRAPH_URI, EMAIL_TO_ADDRESS } from '../config';
import { RESOURCE_BASE, prefixHeaderLines } from '../constants';

async function createEmail(subject, content) {
  if (!EMAIL_TO_ADDRESS) {
    return;
  }

  const id = uuid();
  const uri = `${RESOURCE_BASE}email/${id}`;

  const queryString = `${prefixHeaderLines.mu}
${prefixHeaderLines.nmo}
${prefixHeaderLines.nfo}
${prefixHeaderLines.nie}

INSERT DATA {
  GRAPH ${sparqlEscapeUri(EMAIL_GRAPH_URI)} {
    ${sparqlEscapeUri(uri)} a nmo:Email;
      mu:uuid ${sparqlEscapeString(id)} ;
      nmo:emailTo ${sparqlEscapeString(EMAIL_TO_ADDRESS)} ;
      nmo:messageSubject ${sparqlEscapeString(subject)} ;
      nmo:plainTextMessageContent ${sparqlEscapeString(content)} ;
      nmo:isPartOf <http://data.lblod.info/id/mail-folders/2> .
 }
}`;
  await updateSudo(queryString);
}

export {
  createEmail,
}