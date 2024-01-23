import { sparqlEscapeString, sparqlEscapeUri, sparqlEscapeDateTime, sparqlEscapeBool, uuid } from 'mu';
import { querySudo as query, updateSudo as update } from '@lblod/mu-auth-sudo';
import { JOB } from '../config';
import VP from './vp';

class JobManager {
  constructor() {
    this.isExecuting = false;
  }

  async run() {
    if (this.isExecuting) {
      return;
    }

    let hasRun = false;
    try {
      this.isExecuting = true;
      const job = await getNextScheduledJob();
      if (job) {
        console.debug(`Found next scheduled job <${job.uri}>, executing...`);
        await executeJob(job);
        hasRun = true;
      } else {
        console.debug('No job found in current execution of JobManager#run');
      }
    } catch (error) {
      console.log(`Unexpected error was raised during execution of job: ${error}`);
      console.trace(error);
    } finally {
      this.isExecuting = false;
      if (hasRun) {
        // If we found a scheduled job this run, re-trigger in case there's more
        // Otherwise we just wait until we get triggered by the poll-rate
        this.run();
      }
    }
  }
}

async function createJob(agendaitem, pieces, comment, submitter, isComplete) {
  const jobUuid = uuid();
  const jobContextUuid = uuid();
  const jobUri = `${JOB.RESOURCE_BASE_URI}${jobUuid}`;
  const jobContextUri = `${JOB.CONTEXT_RESOURCE_BASE_URI}${jobContextUuid}`;
  const now = new Date();
  const piecesString = pieces.map(sparqlEscapeUri).join(", ");

  console.log(`Creating job with uri ${sparqlEscapeUri(jobUri)}`);
  await update(`
  PREFIX mu: <http://mu.semte.ch/vocabularies/core/>
  PREFIX ext: <http://mu.semte.ch/vocabularies/ext/>
  PREFIX dct: <http://purl.org/dc/terms/>
  PREFIX prov: <http://www.w3.org/ns/prov#>
  PREFIX adms: <http://www.w3.org/ns/adms#>

  INSERT DATA {
    GRAPH ${sparqlEscapeUri(JOB.GRAPH)} {
        ${sparqlEscapeUri(jobUri)} a ext:SendToVpJob ;
            mu:uuid ${sparqlEscapeString(jobUuid)} ;
            adms:status ${sparqlEscapeUri(JOB.STATUSES.SCHEDULED)} ;
            dct:created ${sparqlEscapeDateTime(now)} ;
            dct:modified ${sparqlEscapeDateTime(now)} ;
            prov:used ${sparqlEscapeUri(jobContextUri)} .
        ${sparqlEscapeUri(jobContextUri)} a ext:SendToVpJobContext ;
            mu:uuid ${sparqlEscapeString(jobContextUuid)} ;
            ext:piece ${piecesString} ;
            ext:isComplete ${sparqlEscapeBool(isComplete)} ;
            ext:agendaitem ${sparqlEscapeUri(agendaitem)} ;
            ${comment ? `ext:comment ${sparqlEscapeString(comment)} ;` : ""}
            ext:submitter ${sparqlEscapeUri(submitter)} .
    }
  }`);

  return {
    id: jobUuid,
    uri: jobUri,
    status: JOB.STATUSES.SCHEDULED,
    created: now,
    modified: now,
    context: {
      agendaitem,
      pieces,
      comment,
      submitter,
      isComplete,
    },
  };
}

async function getNextScheduledJob() {
  const result = await query(`
  PREFIX mu: <http://mu.semte.ch/vocabularies/core/>
  PREFIX ext: <http://mu.semte.ch/vocabularies/ext/>
  PREFIX dct: <http://purl.org/dc/terms/>
  PREFIX prov: <http://www.w3.org/ns/prov#>
  PREFIX adms: <http://www.w3.org/ns/adms#>
  PREFIX dossier: <https://data.vlaanderen.be/ns/dossier#>
  PREFIX besluit: <http://data.vlaanderen.be/ns/besluit#>
  PREFIX foaf: <http://xmlns.com/foaf/0.1/>

  SELECT DISTINCT 
  ?uri ?id ?status ?created ?modified 
  ?agendaitem ?piece ?comment ?submitter ?isComplete
  WHERE {
    GRAPH ${sparqlEscapeUri(JOB.GRAPH)} {
      VALUES ?status {
        ${sparqlEscapeUri(JOB.STATUSES.SCHEDULED)}
      }
      ?uri a
        ext:SendToVpJob ;
        mu:uuid ?id ;
        dct:created ?created ;
        dct:modified ?modified ;
        prov:used ?context ;
        adms:status ?status .

      ?context 
        ext:piece ?piece ;
        ext:agendaitem ?agendaitem ;
        ext:submitter ?submitter ;
        ext:isComplete ?isComplete .

      OPTIONAL {
        ?context ext:comment ?comment .
      }

      FILTER NOT EXISTS {
        ?job a ext:SendToVpJob ;
           adms:status ${sparqlEscapeUri(JOB.STATUSES.BUSY)} .
      }
    }
  } ORDER BY ASC(?created)`);

  const bindings = result.results.bindings;
  if (bindings.length > 0) {
    return {
      id: bindings[0]['id'].value,
      uri: bindings[0]['uri'].value,
      status: bindings[0]['status'].value,
      created: bindings[0]['created'].value,
      modified: bindings[0]['modified'].value,
      context: {
        agendaitem: bindings[0]['agendaitem'].value,
        pieces: bindings.map((binding) => binding['piece'].value),
        comment: bindings[0]['comment']?.value,
        submitter: bindings[0]['submitter'].value,
        isComplete: bindings[0]['isComplete'].value === "1",
      }
    };
  } else {
    return null;
  }
}

async function getJob(uuid) {
  const result = await query(`
  PREFIX adms: <http://www.w3.org/ns/adms#>
  PREFIX dct: <http://purl.org/dc/terms/>
  PREFIX ext: <http://mu.semte.ch/vocabularies/ext/>
  PREFIX mu: <http://mu.semte.ch/vocabularies/core/>
  PREFIX prov: <http://www.w3.org/ns/prov#>
  PREFIX schema: <http://schema.org/>

  SELECT DISTINCT
  ?uri ?id ?status ?created ?modified 
  ?agendaitem ?piece ?comment ?submitter ?isComplete
  ?errorMessage
  WHERE {
    GRAPH ${sparqlEscapeUri(JOB.GRAPH)} {
      ?uri a ext:SendToVpJob ;
           mu:uuid ${sparqlEscapeString(uuid)} ;
           dct:created ?created ;
           dct:modified ?modified ;
           prov:used ?context ;
           adms:status ?status .

      OPTIONAL {
        ?uri schema:error ?errorMessage .
      }

      ?context 
        ext:piece ?piece ;
        ext:agendaitem ?agendaitem ;
        ext:submitter ?submitter ;
        ext:isComplete ?isComplete .
      OPTIONAL {
        ?context ext:comment ?comment .
      }
    }
  }`);

  const bindings = result.results.bindings;
  if (bindings.length > 0) {
    return {
      id: uuid,
      uri: bindings[0]['uri'].value,
      status: bindings[0]['status'].value,
      created: bindings[0]['created'].value,
      modified: bindings[0]['modified'].value,
      errorMessage: bindings[0]['errorMessage']?.value,
      context: {
        agendaitem: bindings[0]['agendaitem'].value,
        pieces: bindings.map((binding) => binding['piece'].value),
        comment: bindings[0]['comment']?.value,
        submitter: bindings[0]['submitter'].value,
        isComplete: bindings[0]['isComplete'].value === "1",
      }
    };
  } else {
    return null;
  }
}

async function executeJob(job) {
  try {
    await updateJobStatus(job.uri, JOB.STATUSES.BUSY);

    // Do the job related stuff
    const { agendaitem, pieces, comment, submitter, isComplete } = job.context;
    console.log(job.context);
    await VP.createAndsendDossier(agendaitem, pieces, comment, submitter, isComplete);

    await updateJobStatus(job.uri, JOB.STATUSES.SUCCESS);
    console.log("**************************************");
    console.log(`Successfully finished job <${job.uri}>`);
    console.log("**************************************");
  } catch (e) {
    console.log(`Execution of job <${job.uri}> failed: ${e}`);
    console.trace(e);
    await updateJobStatus(job.uri, JOB.STATUSES.FAILED, e.message);
  }
}

async function updateJobStatus(uri, status, errorMessage) {
  await update(`
  PREFIX dct: <http://purl.org/dc/terms/>
  PREFIX adms: <http://www.w3.org/ns/adms#>
  PREFIX schema: <http://schema.org/>

  DELETE WHERE {
    GRAPH ${sparqlEscapeUri(JOB.GRAPH)} {
      ${sparqlEscapeUri(uri)} 
        dct:modified ?modified ;
        adms:status ?status.
    }
  }

  ;

  INSERT DATA {
    GRAPH ${sparqlEscapeUri(JOB.GRAPH)} {
      ${sparqlEscapeUri(uri)} 
        dct:modified ${sparqlEscapeDateTime(new Date())} ;
        ${errorMessage ? `schema:error ${sparqlEscapeString(errorMessage)} ;` : ""}
        adms:status ${sparqlEscapeUri(status)} .
    }
  }`);
}

async function cleanupOngoingJobs() {
  await update(`
  PREFIX adms: <http://www.w3.org/ns/adms#>
  PREFIX ext: <http://mu.semte.ch/vocabularies/ext/>

  DELETE {
    GRAPH ${sparqlEscapeUri(JOB.GRAPH)} {
      ?uri adms:status ${sparqlEscapeUri(JOB.STATUSES.BUSY)} .
    } 
  } 
  INSERT {
    GRAPH ${sparqlEscapeUri(JOB.GRAPH)} {
      ?uri adms:status ${sparqlEscapeUri(JOB.STATUSES.FAILED)} .
    } 
  } 
  WHERE {
    GRAPH ${sparqlEscapeUri(JOB.GRAPH)} {
      ?uri 
        a ext:ReportGenerationJob ;
        adms:status ${sparqlEscapeUri(JOB.STATUSES.BUSY)} .
    }
  }
  `);
}


export {
  JobManager,
  createJob,
  getJob,
  cleanupOngoingJobs
};
