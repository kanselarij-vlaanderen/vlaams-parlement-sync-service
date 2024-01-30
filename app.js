import { app, errorHandler } from 'mu';
import fs from 'fs';
import bodyParser from 'body-parser';
import { CronJob } from 'cron';
import VP from './lib/vp';
import { fetchCurrentUser } from "./lib/utils";
import { getPieceUris,
  isAgendaItemReadyForVP,
  getMissingPieces,
  getDecisionmakingFlowForAgendaitem
} from './lib/agendaitem';
import { getPieceMetadata, getSubmittedPieces } from './lib/piece';
import { getDecisionmakingFlow } from './lib/decisionmaking-flow';
import {
  ENABLE_DEBUG_FILE_WRITING,
  ENABLE_SENDING_TO_VP_API,
  ENABLE_ALWAYS_CREATE_PARLIAMENT_FLOW,
  PARLIAMENT_FLOW_STATUSES
} from './config';

import {
  createOrUpdateParliamentFlow,
  enrichPiecesWithPreviousSubmissions
} from "./lib/parliament-flow";
import { syncFlowsByStatus } from './lib/sync';

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

const cacheClearTimeout = process.env.CACHE_CLEAR_TIMEOUT || 3000;

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
  // Set default URI for debugging purposes.
  // Default URI points to https://kaleidos-test.vlaanderen.be/dossiers/6398392DC2B90D4571CF86EA/deeldossiers
  const decisionmakingFlowUri = await getDecisionmakingFlowForAgendaitem(agendaitemUri) ?? 'http://themis.vlaanderen.be/id/besluitvormingsaangelegenheid/6398392DC2B90D4571CF86EA';

  const decisionmakingFlow = await getDecisionmakingFlow(decisionmakingFlowUri);

  if (!decisionmakingFlow) {
    return next({ message: 'Could not find decisionmaking flow', status: 404 });
  }

  let pieces = await getPieceMetadata(piecesUris);

  if (pieces.length === 0) {
    return next({ message: 'Could not find any files to send for decisionmaking flow', status: 404 });
  }

  if (decisionmakingFlow.parliamentFlow) {
    pieces = await enrichPiecesWithPreviousSubmissions(decisionmakingFlow.parliamentFlow, pieces);
  }

  if (ENABLE_DEBUG_FILE_WRITING) {
    fs.writeFileSync('/debug/pieces.json', JSON.stringify(pieces, null, 2));
  }

  let payload;
  let contact = {
    name: `${currentUser.firstName} ${currentUser.familyName}`,
    email: currentUser.mbox? currentUser.mbox.replace('mailto:', '') : ''
  };
  try {
    payload = VP.generatePayload(decisionmakingFlow, pieces, comment, contact);
  } catch (error) {
    return next({
      message: `An error occurred while creating the payload: "${error.message}"`,
      status: 500,
    });
  }

  // For debugging
  if (ENABLE_DEBUG_FILE_WRITING) {
    fs.writeFileSync('/debug/payload.json', JSON.stringify(payload, null, 2));
  }
  if (ENABLE_SENDING_TO_VP_API) {
    let response;
    try {
      response = await VP.sendDossier(payload);
    } catch (error) {
      console.log(error.message);
      return res.status(500).send({ message: 'Error while sending to VP: ' + error.message });
    }

    if (response.ok) {
      const responseJson = await response.json();
      if (ENABLE_DEBUG_FILE_WRITING) {
        fs.writeFileSync('/debug/response.json', JSON.stringify(responseJson, null, 2));
      }
      await createOrUpdateParliamentFlow(responseJson, decisionmakingFlowUri, pieces, currentUser.user, comment, isComplete);

      return setTimeout(() => {
        res.status(200).send()
      }, cacheClearTimeout);
    } else {
      if (ENABLE_DEBUG_FILE_WRITING) {
        fs.writeFileSync('/debug/response.json', JSON.stringify(response, null, 2));
      }
      let errorMessage = `VP API responded with status ${response.status} and the following message: "${response.statusText}"`
      if (response.error && response.error.message) {
        errorMessage = response.error.message;
      }
      return res
        .status(500)
        .send({
          message: errorMessage
        });
    }
  } else {
    if (ENABLE_ALWAYS_CREATE_PARLIAMENT_FLOW) {
      let allFiles = [];
      for (const piece of pieces) {
        for (const file of piece.files) {
          allFiles.push({
            "id": file.uri,
            "pfls": "" + Math.floor(1000 + Math.random() * 9000), // random 4-digit pobj
          });
        }
      }
      let mockResponseJson = {
        "MOCKED": true,
        "status": "SUCCESS",
        "id": decisionmakingFlowUri,
        "pobj": "" + Math.floor(100 + Math.random() * 900), // random 3-digit pobj
        files: allFiles
      }
      if (ENABLE_DEBUG_FILE_WRITING) {
        fs.writeFileSync('/debug/response.json', JSON.stringify(mockResponseJson, null, 2));
      }
      await createOrUpdateParliamentFlow(mockResponseJson, decisionmakingFlowUri, pieces, currentUser.user, comment, isComplete);
    }
    return setTimeout(() => {
      return res.status(204).end();
    }, cacheClearTimeout);
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
