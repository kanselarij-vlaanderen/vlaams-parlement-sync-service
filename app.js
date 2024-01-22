import { app, errorHandler } from 'mu';
import bodyParser from 'body-parser';
import { CronJob } from 'cron';
import { fetchCurrentUser } from "./lib/utils";
import {
  getPieceUris,
  isAgendaItemReadyForVP,
  getMissingPieces,
} from './lib/agendaitem';
import { getPieceMetadata, getSubmittedPieces } from './lib/piece';
import { PARLIAMENT_FLOW_STATUSES } from './config';

import { syncFlowsByStatus } from "./lib/sync";
import { JobManager, createJob } from "./lib/jobs";

/** Schedule report generation cron job */
const cronPattern = process.env.POLLING_CRON_PATTERN || '0 0 7 * * *';
const cronJob = new CronJob(
	cronPattern,
	function () {
    const { COMPLETE, INCOMPLETE } = PARLIAMENT_FLOW_STATUSES;
    syncFlowsByStatus([COMPLETE, INCOMPLETE]);
	}, // onTick
	null, // onComplete
	true, // start
);

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
    const ready = await getPieceMetadata(piecesUris);
    const missing = await getMissingPieces(uri, [...ready, ...submitted]);

    return res.status(200).send({ data: { ready, missing } });
  }
  return res.status(200).send({ data: {
      ready: [],
      missing: await getMissingPieces(uri, [...submitted])
    }
  });
});

app.post('/debug-resync-error-flows', async function (req, res, next) {
  await syncFlowsByStatus([PARLIAMENT_FLOW_STATUSES.VP_ERROR]);
  return res.status(204).send();
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

  await createJob(agendaitemUri, piecesUris, comment, currentUser, isComplete);
});

app.get("/send-to-vp-jobs/:uuid", async function (req, res) {
  const job = await getJob(req.params.uuid);
  if (job) {
    return res.status(200).send({
      data: {
        type: "send-to-vp-job",
        id: job.id,
        attributes: {
          uri: job.uri,
          meeting: job.meeting,
          status: job.status,
          created: job.created,
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
