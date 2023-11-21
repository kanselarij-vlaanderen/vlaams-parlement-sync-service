import { app, errorHandler } from 'mu';
import fs from 'fs';
import bodyParser from 'body-parser';
import VP from './lib/vp';
import { getDecisionmakingFlow, getFiles, getPieces, isDecisionMakingFlowReadyForVP } from './lib/decisionmaking-flow';
import { ENABLE_DEBUG_FILE_WRITING, ENABLE_SENDING_TO_VP_API } from './config';
import { fetchCurrentUser } from './lib/utils';
import {
  getParliamentFlowAndSubcase,
  createParliamentFlow,
  createParliamentSubcase,
  createSubmissionActivity,
} from "./lib/parliament-flow";

app.use(bodyParser.json());

app.get('/is-ready-for-vp/', async function (req, res, next) {
  const uri = req.query.uri;
  const decisionmakingFlow = await getDecisionmakingFlow(uri);

  if (!decisionmakingFlow) {
    return next({ message: 'Could not find decisionmaking flow', status: 404 });
  }

  const isReady = await isDecisionMakingFlowReadyForVP(uri);

  return res.send({ isReady }).end();
});

app.post('/', async function (req, res, next) {
  console.log("Sending dossier...");

  const uri = req.query.uri;

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

  const piecesResponse = await getPieces(decisionmakingFlowUri);
  if (!piecesResponse?.results?.bindings) {
    return next({ message: 'Could not find any pieces to send for decisionmaking flow', status: 404 });
  }

  const uris = piecesResponse.results.bindings.map((b) => b.uri.value);
  const pieces = await getFiles(uris);

  const payload = {
    '@context': [
      "https://data.vlaanderen.be/doc/applicatieprofiel/besluitvorming/erkendestandaard/2021-02-04/context/besluitvorming-ap.jsonld",
      {
          "Stuk.isVoorgesteldDoor": "https://data.vlaanderen.be/ns/dossier#isVoorgesteldDoor",
          "Concept": "http://www.w3.org/2004/02/skos/core#Concept",
          "format": "http://purl.org/dc/terms/format",
          "content": "http://www.w3.org/ns/prov#value",
          "prefLabel": "http://www.w3.org/2004/02/skos/core#prefLabel"
      }
    ],
    '@id': decisionmakingFlow.uri,
    '@type': 'Besluitvormingsaangelegenheid',
    'Besluitvormingsaangelegenheid.naam': decisionmakingFlow.name,
    'Besluitvormingsaangelegenheid.alternatieveNaam': decisionmakingFlow.altName,
    'Besluitvormingsaangelegenheid.beleidsveld': decisionmakingFlow.governmentFields.map(
      (field) => ({
        '@id': field.uri,
        '@type': 'Concept',
        prefLabel: field.label,
      })
    ),
    '@reverse': {
      'Dossier.isNeerslagVan': {
        '@id': decisionmakingFlow.case,
        '@type': 'Dossier',
        'Dossier.bestaatUit': pieces.map(
          (piece) => ({
            '@id': piece.uri,
            '@type': 'Stuk',
            'Stuk.naam': piece.name,
            'Stuk.creatiedatum': piece.created.toISOString(),
            'Stuk.type': piece.type.uri,
            // TODO: it's propably more helpful for them to have the type label instead of only the type URI
            // 'Stuk.type': {
            //   '@id': piece.type.uri,
            //   '@type': 'Concept',
            //   prefLabel: piece.type.label,
            // },
            'Stuk.isVoorgesteldDoor': piece.files.map((file) => {
              const content = fs.readFileSync(
                file.shareUri.replace('share://', '/share/'),
                { encoding: 'base64' }
              );
              return {
                '@id': file.uri,
                '@type': 'http://www.w3.org/ns/dcat#Distribution',
                format: file.format,
                filename: file.name,
                content,
              }
            })
          })
        ),
      }
    }
  };


  // For debugging
  if (ENABLE_DEBUG_FILE_WRITING) {
    fs.writeFileSync('/debug/payload.json', JSON.stringify(payload, null, 2));
  }

  if (ENABLE_SENDING_TO_VP_API) {
    const response = await VP.sendDossier(payload);

    if (response.ok) {
      const responseJson = await response.json();
      const currentUser = await fetchCurrentUser(req.headers["mu-session-id"]);

      const parliamentId = responseJson.pobj;

      let { parliamentFlow, parliamentSubcase } =
        await getParliamentFlowAndSubcase(decisionmakingFlowUri);

      parliamentFlow ??= await createParliamentFlow(
        parliamentId,
        decisionmakingFlowUri
      );
      parliamentSubcase ??= await createParliamentSubcase(parliamentFlow);

      await createSubmissionActivity(parliamentSubcase, pieces, currentUser);

      return res.status(200).end();
    } else {
      return res.status(500).end();
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
