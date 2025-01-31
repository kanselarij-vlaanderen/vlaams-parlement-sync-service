import { app, errorHandler } from 'mu';
import bodyParser from 'body-parser';
import { CronJob } from 'cron';
import VP from './lib/vp';
import { fetchCurrentUser } from "./lib/utils";
import {
  getPieceUris,
  isAgendaItemReadyForVP,
  getMissingPieces,
  getRequiredPieces,
} from './lib/agendaitem';
import {
  getPieceMetadata,
  filterRedundantFiles,
  getSubmittedPieces
} from './lib/piece';
import {
  PARLIAMENT_FLOW_STATUSES
} from './config';

import { syncFlowsByStatus, syncIncomingFlows, syncSubmittedFlows } from './lib/sync';
import { JobManager, cleanupOngoingJobs, createJob, getJob } from "./lib/jobs";
import { getPobjFromParliamentflow } from './lib/parliament-flow';

/** Schedule VP flows sync cron job */
const statusCronPattern = process.env.STATUS_POLLING_CRON_PATTERN || process.env.POLLING_CRON_PATTERN || '0 0 7 * * *';
const incomingCronPattern = process.env.INCOMING_POLLING_CRON_PATTERN || process.env.POLLING_CRON_PATTERN || '0 0 7 * * *';
console.log('syncSubmittedFlows set to CRON pattern ' + statusCronPattern);
new CronJob(
	statusCronPattern,
	() => {
    console.log(`syncSubmittedFlows triggered by cron job at ${new Date().toISOString()}`);
    syncSubmittedFlows(true)
  }, // onTick
	null, // onComplete
	true, // start
);
console.log('syncIncomingFlows set to CRON pattern ' + incomingCronPattern);
new CronJob(
	incomingCronPattern,
	() => {
    console.log(`syncIncomingFlows triggered by cron job at ${new Date().toISOString()}`);
    syncIncomingFlows(true)
  }, // onTick
	null, // onComplete
	true, // start
);

cleanupOngoingJobs();

const jobManager = new JobManager();
jobManager.run();
const runJobManagerJob = CronJob.from({
  cronTime: "0 * * * * *",
  onTick: function () {
    console.log(`Jobs triggered by cron job at ${new Date().toISOString()}`);
    jobManager.run();
  },
  start: true,
});

app.use(bodyParser.json());

/* Route to verify the credentials for getting an access token */
app.get('/verify-credentials/', async function (req, res, next) {
  try {
    const accessToken = await VP.getAccessToken();
    if (accessToken) {
      try {
        const ping = await VP.ping();
        console.log(ping);
        return res.send({ message: 'Credentials valid. Access token was successfully retrieved and service is reachable.'});
      } catch (e) {
        return res.send({ error: 'Error while pinging VP-API: ' + JSON.stringify(e) });
      }
    } else {
      return res.send({ message: 'Credentials invalid! Access token could not be retrieved.'});
    }
  } catch (e) {
    return res.send({ error: 'Error while retrieving access token: ' + JSON.stringify(e) });
  }
});

app.get('/healthcheck', async function (_req, res, next) {
  try {
    console.log('Doing a healthcheck');
    const accessToken = await VP.getAccessToken();
    if (accessToken) {
      try {
        await VP.ping();
        await VP.fetchSubmittedFlows();
        await VP.fetchIncomingFlows();
        console.log('Healthcheck finished successfully');
        return res.send({ message: 'Credentials valid, VP endpoints are not returning any errors and service is reachable.'});
      } catch (e) {
        return next({ message: 'Error while reaching VP-API: ' + JSON.stringify(e) });
      }
    } else {
      return next({ message: 'Credentials invalid! Access token could not be retrieved.'});
    }
  } catch (e) {
    return next({ message: 'Error while retrieving access token: ' + JSON.stringify(e) });
  }
});

app.get('/is-ready-for-vp/', async function (req, res, next) {
  const uri = req.query.uri;
  if (!uri) {
    return next({ message: 'Query parameter "uri" must be passed in', status: 400 });
  }

  const isReady = await isAgendaItemReadyForVP(uri);

  return res.send({ isReady }).end();
});

app.get('/pieces-ready-to-be-sent', async function (req, res, next) {
  const uri = req.query.uri;
  if (!uri) {
    return next({ message: 'Query parameter "uri" must be passed in', status: 400 });
  }

  const isReady = await isAgendaItemReadyForVP(uri);
  if (!isReady) {
    return next({ message: 'Agendaitem cannot be sent to VP', status: 404 });
  }

  const piecesUris = await getPieceUris(uri);
  const submitted = await getSubmittedPieces(piecesUris);
  if (piecesUris.length > 0) {
    const pieces = await getPieceMetadata(piecesUris);
    const ready = filterRedundantFiles(pieces, submitted);
    const missing = await getMissingPieces(uri, [...ready, ...submitted]);
    const required = await getRequiredPieces(uri, [...ready]);

    return res.status(200).send({ data: { ready, missing, required } });
  }
  return res.status(200).send({ data: {
      ready: [],
      missing: await getMissingPieces(uri, [...submitted]),
      required: []
    }
  });
});

/* Note: this should be called from an active session in the browser,
   it needs credentials from mu-authorization.
   Use this command in the console:
   fetch('/vlaams-parlement-sync/debug-resync-error-flows', {
     method: 'POST'
   })
*/
app.post('/debug-resync-error-flows', async function (req, res, next) {
  await syncFlowsByStatus([PARLIAMENT_FLOW_STATUSES.VP_ERROR]);
  return res.status(204).send();
});

/* Note: this should be called from an active session in the browser,
   it needs credentials from mu-authorization.
   Use this command in the console:
   fetch('/vlaams-parlement-sync/debug-resync-submitted-to-parliament', {
     method: 'POST'
   })
*/
app.post('/debug-resync-submitted-to-parliament', async function (req, res, next) {
  await syncSubmittedFlows();
  return res.status(204).send();
})

/* Note: this should be called from an active session in the browser,
   it needs credentials from mu-authorization.
   Use this command in the console:
   fetch('/vlaams-parlement-sync/debug-resync-incoming-flows', {
     method: 'POST'
   })
*/
app.post('/debug-resync-incoming-flows', async function (req, res, next) {
  await syncIncomingFlows();
  return res.status(204).send();
})

/* Note: this can be called from an active session in the browser,
   or from a forwarded port on the container.
   Use this command in the console:
   fetch('/vlaams-parlement-sync/debug-check-pobj-status?pobj=1795047')
   and then check the response in the network tab
*/
app.get('/debug-check-pobj-status', async function (req, res, next) {
  if (req.query.pobj) {
    let statuses = await VP.getStatusForFlow(req.query.pobj);
    return res.status(200).send(JSON.stringify(statuses));
  } else {
    return res.status(400).send("pobj must be provided");
  }
})

/* Note: this can be called from an active session in the browser,
   or from a forwarded port on the container.
   Use this command in the console:
   fetch('/vlaams-parlement-sync/debug-check-submitted-flows?dagen=30')
   and then check the response in the network tab
*/
app.get('/debug-check-submitted-flows', async function (req, res, next) {
  try {
    let days;
    if (req.query.dagen) {
      days = +req.query.dagen;
    }
    let docs = await VP.fetchSubmittedFlows(days);
    return res.status(200).send(JSON.stringify(docs));
  } catch (error) {
    return res.status(500).send(JSON.stringify(error.message));
  }
})


/* Note: this can be called from an active session in the browser,
   or from a forwarded port on the container.
   Use this command in the console:
   fetch('/vlaams-parlement-sync/debug-check-incoming-flows?transform=true')
   and then check the response in the network tab.
   Set the transform query param to false (or omit it) to get the raw response
   from VP
*/
app.get('/debug-check-incoming-flows', async function (req, res, next) {
  try {
    let docs = await VP.fetchIncomingFlows(true, (req.query.transform === 'true'));
    return res.status(200).send(JSON.stringify(docs));
  } catch (error) {
    return res.status(500).send(JSON.stringify(error.message));
  }
})

app.post('/', async function (req, res, next) {
  console.log("Sending dossier...");
  console.log(req.body);

  const agendaitemUri = req.body.agendaitem;
  if (!agendaitemUri) {
    return next({ message: 'Query parameter "agendaitem" must be passed in', status: 400 });
  }

  const piecesUris = req.body.pieces;
  if (!piecesUris) {
    return next({ message: 'Query parameter "pieces" must be passed in', status: 400 });
  }

  if (!piecesUris.length) {
    return next({ message: 'At least one piece must be sent to VP', status: 400 });
  }

  const comment = req.body.comment;
  const isComplete = req.body.isComplete;

  const currentUser = await fetchCurrentUser(req.headers["mu-session-id"]);
  if (!currentUser) {
    return next({ message: 'Could not find user for session', status: 404 });
  }

  const job = await createJob(
    agendaitemUri,
    piecesUris,
    comment,
    currentUser.uri,
    isComplete
  );
  jobManager.run();
  return res.status(201).send(job);
});

app.get("/send-to-vp-jobs/:uuid", async function (req, res) {
  const job = await getJob(req.params.uuid);
  if (job) {
    return res.status(200).send({
      data: {
        type: "send-to-vp-job",
        id: job.id,
        attributes: {
          ...job
        },
      },
    });
  } else {
    return res
      .status(404)
      .send({
        error: `Could not find send-to-vp-job with uuid ${req.params.uuid}`,
      });
  }
});

app.post('/relink-decisionmaking-flow', async function (req, res, next) {
  const decisionmakingFlowUri = req.body.decisionmakingFlowUri;
  if (!decisionmakingFlowUri) {
    return next({ message: 'Request body must contain "decisionmakingFlowUri" field', status: 400 });
  }

  const caseUri = req.body.caseUri;
  if (!caseUri) {
    return next({ message: 'Request body must contain "caseUri" field', status: 400 });
  }

  const parliamentFlowUri = req.body.parliamentFlowUri;
  if (!parliamentFlowUri) {
    return next({ message: 'Request body must contain "parliamentFlowUri" field', status: 400 });
  }

  try {
    const { pobj } = await getPobjFromParliamentflow(parliamentFlowUri);

    const decisionmakingFlow = {
      uri: decisionmakingFlowUri,
      case: caseUri,
      pobj,
    };
    const payload = VP.generateNotificationPayload(decisionmakingFlow, null)
    await VP.notifyReceivedDocument(payload);
    return res.status(204).send();
  } catch (e) {
    return next({
      message: `Something went wrong while notifying VP about decisionmaking flow change: ${e}`,
      status: 500
    });
  }
});

/*
 * 1. Fetch necessary data from Kaleidos triplestore
 * 2. Convert data to JSON-LD format
 * 3. Send data to VP API
 *
 * Down the line we want to make this service reactive. When a new document is
 * uploaded we check if it's related to a case that is "ready" to be sent to
 * the VP.
 *
 * This is a bit advanced and out-of-scope for the current POC. First we will
 * focus on ensuring that we can verify that a case is "ready", as we can later
 * re-use this logic.
 *
 * Afterwards, we want to fetch all the files related to said case. Let's take
 * performance into account as well and check wheter doing a single or multiple
 * queries end up being faster. We should take into account that there's quite
 * a lot of files that we need to fetch (upwards of 10 per case) and all their
 * metadata.
 *
 * Once we have all the data, we go on to sending it to the VP using the pre-
 * determined JSON-LD payload.
 */

app.use(errorHandler);
