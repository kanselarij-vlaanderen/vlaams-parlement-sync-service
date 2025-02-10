import { uuid, sparqlEscapeUri, sparqlEscapeString } from 'mu';
import { updateSudo } from '@lblod/mu-auth-sudo';
import { EMAIL_GRAPH_URI, EMAIL_FROM_ADDRESS, EMAIL_TO_ADDRESS, EMAIL_TO_ADDRESS_ON_FAILURE } from '../config';
import { RESOURCE_BASE, prefixHeaderLines } from '../constants';

async function createEmail(subject, content, to) {
  if (!to) {
    console.error('** Mail not created, there was no email address found to send to **');
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
      nmo:messageFrom ${sparqlEscapeString(EMAIL_FROM_ADDRESS)} ;
      nmo:emailTo ${sparqlEscapeString(to)} ;
      nmo:messageSubject ${sparqlEscapeString(subject)} ;
      nmo:plainTextMessageContent ${sparqlEscapeString(content)} ;
      nmo:isPartOf <http://themis.vlaanderen.be/id/mail-folders/4296e6af-7d4f-423d-ba89-ed4cbbb33ae7> .
 }
}`;
  await updateSudo(queryString);
}

async function createEmailOnSyncSuccess(subject, content) {
  await createEmail(subject, content, EMAIL_TO_ADDRESS);
}

async function createEmailOnSyncFailure(subject, content) {
  await createEmail(subject, content, EMAIL_TO_ADDRESS_ON_FAILURE);
}

export {
  createEmail,
  createEmailOnSyncSuccess,
  createEmailOnSyncFailure,
}
