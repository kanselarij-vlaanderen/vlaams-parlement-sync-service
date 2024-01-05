import { app, errorHandler } from 'mu';
import fs from 'fs';
import bodyParser from 'body-parser';
import VP from './lib/vp';
import { getDecisionmakingFlow, getFiles, getAllPieces, isDecisionMakingFlowReadyForVP } from './lib/decisionmaking-flow';
import { ENABLE_DEBUG_FILE_WRITING, ENABLE_SENDING_TO_VP_API, PARLIAMENT_FLOW_STATUSES } from './config';
import { fetchCurrentUser } from './lib/utils';
import {
  getParliamentFlowAndSubcase,
  createParliamentFlow,
  createParliamentSubcase,
  createSubmissionActivity,
  enrichPiecesWithPreviousSubmissions,
  createSubmittedPieces,
  updateParliamentFlowStatus,
} from "./lib/parliament-flow";

app.use(bodyParser.json());

app.get('/is-ready-for-vp/', async function (req, res, next) {
  const uri = req.query.uri;
  if (!uri) {
    return next({ message: 'Query parameter "uri" must be passed in', status: 400 });
  }

  const decisionmakingFlow = await getDecisionmakingFlow(uri);

  if (!decisionmakingFlow) {
    return next({ message: 'Could not find decisionmaking flow', status: 404 });
  }

  const isReady = await isDecisionMakingFlowReadyForVP(uri);

  return res.send({ isReady }).end();
});

app.get('/pieces-ready-to-be-sent', async function (req, res, next) {
  const uri = req.query.uri;
  if (!uri) {
    return next({ message: 'Query parameter "uri" must be passed in', status: 400 });
  }

  const decisionmakingFlow = await getDecisionmakingFlow(uri);
  if (!decisionmakingFlow) {
    return next({ message: 'Could not find decisionmaking flow', status: 404 });
  }

  const piecesUris = await getAllPieces(uri);
  const pieces = await getFiles(piecesUris);

  const data = pieces.map((piece) => ({
    type: 'piece',
    id: piece.id
  }));

  return res
    .status(200)
    .send({ data });
});

app.post('/', async function (req, res, next) {
  console.log("Sending dossier...");

  const uri = req.query.uri;
  if (!uri) {
    return next({ message: 'Query parameter "uri" must be passed in', status: 400 });
  }

  const comment = req.query.comment;
  const isComplete = req.query.isComplete === 'true';

  // Set default URI for debugging purposes.
  // Default URI points to https://kaleidos-test.vlaanderen.be/dossiers/6398392DC2B90D4571CF86EA/deeldossiers
  const decisionmakingFlowUri = uri ?? 'http://themis.vlaanderen.be/id/besluitvormingsaangelegenheid/6398392DC2B90D4571CF86EA';

  const decisionmakingFlow = await getDecisionmakingFlow(decisionmakingFlowUri);

  if (!decisionmakingFlow) {
    return next({ message: 'Could not find decisionmaking flow', status: 404 });
  }

  const isReady = await isDecisionMakingFlowReadyForVP(decisionmakingFlowUri);

  if (!isReady) {
    return next({ message: 'Decisionmaking flow is not ready to be sent to the Flemish Parliament API', status: 400 });
  }

  const piecesUris = await getAllPieces(decisionmakingFlowUri);
  if (!piecesUris.length) {
    return next({ message: 'Could not find any pieces to send for decisionmaking flow', status: 404 });
  }
  let pieces = await getFiles(piecesUris);

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
  try {
    payload = VP.generatePayload(decisionmakingFlow, pieces, comment);
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
      const currentUser = await fetchCurrentUser(req.headers["mu-session-id"]);
      if (!currentUser) {
        return next({ message: 'Could not find user for session', status: 404 });
      }

      const parliamentId = responseJson.pobj;
      pieces.forEach((piece) => {
        piece.files.forEach((file) => {
          const parliamentId = responseJson.files.find((r) => r.id === file.uri)?.pfls;
          if (parliamentId) {
            file.parliamentId = parliamentId;
          }
        });
      });

      if (ENABLE_DEBUG_FILE_WRITING) {
        fs.writeFileSync('/debug/pieces.json', JSON.stringify(pieces, null, 2));
      }

      let { parliamentFlow, parliamentSubcase } =
        await getParliamentFlowAndSubcase(decisionmakingFlowUri);

      parliamentFlow ??= await createParliamentFlow(
        parliamentId,
        decisionmakingFlowUri
      );
      parliamentSubcase ??= await createParliamentSubcase(parliamentFlow);

      const submissionActivity = await createSubmissionActivity(parliamentSubcase, currentUser, comment);
      await createSubmittedPieces(submissionActivity, pieces)

      await updateParliamentFlowStatus(
        parliamentFlow,
        isComplete
          ? PARLIAMENT_FLOW_STATUSES.COMPLETE
          : PARLIAMENT_FLOW_STATUSES.INCOMPLETE,
      );

      return res.status(200).end();
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
    return res.status(204).end();
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
