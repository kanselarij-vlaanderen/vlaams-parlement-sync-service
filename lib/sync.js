import fs from 'fs';
import { uuid } from 'mu';
import VP from "./vp";
import {
  createParliamentFlow,
  createParliamentSubcase,
  createRetrievalActivity,
  createRetrievedPiece,
  getFlowsByStatus,
  getGeneratedSubcaseFromPobj,
  getParliamentSubcaseFromPobj,
  pflsIsKnown,
  pobjIsKnown,
  updateParliamentFlowStatus,
} from "./parliament-flow";
import {
  KALEIDOS_HOST_URL,
  PARLIAMENT_FLOW_STATUSES,
  VP_PARLIAMENT_FLOW_STATUSES,
  DOCUMENT_TYPES,
  ACCESS_LEVELS
} from "../config";
import { createCaseDecisionmakingFlowAndSubcase, createSubcase, createSubmissionActivity, getCaseFromDecisionmakingFlow, getDecisionmakingFlowId } from "./decisionmaking-flow";
import {
  createFile,
  deleteFile,
  fileIsKnown,
  linkFileToPiece,
  linkDerivedFileToSourceFile,
  pieceIsOnFinalMeeting,
  createDocumentContainerAndPiece,
  getPieceFromFile,
  moveDerivedAndSourceLinks,
} from "./piece";
import { createEmail } from './email';

/**
 * For all flows in Kaleidos that have a given status, it checks for
 * status updates on the VP API and updates their status in
 * Kaleidos accordingly.
 */
async function syncFlowsByStatus(statuses) {
  const pendingFlows = await getFlowsByStatus(statuses);
  for (const flow of pendingFlows) {
    let statuses;
    try {
      console.log(`Syncing status for ${flow.parliamentId}...`);
      statuses = await VP.getStatusForFlow(flow.parliamentId);
    } catch (error) {
      console.error(error);
    }
    if (statuses?.statussen) {
      if (
        statuses.statussen.find(
          (statusChange) =>
            statusChange.status === VP_PARLIAMENT_FLOW_STATUSES.BEING_HANDLED
        )
      ) {
        console.log(
          `Changing status for flow nr ${flow.parliamentId} with uri ${flow.uri} to BEING_HANDLED`
        );
        await updateParliamentFlowStatus(
          flow,
          PARLIAMENT_FLOW_STATUSES.BEING_HANDLED,
          true
        );
      }
    } else {
      // note: We can't do this because there will also be no status when the
      // case has not been submitted
      // await updateParliamentFlowStatus(
      //   flow,
      //   PARLIAMENT_FLOW_STATUSES.VP_ERROR,
      //   true
      // );
      console.warn(
        `Invalid response from status API for flow nr ${flow.parliamentId} with uri ${flow.uri}: ${JSON.stringify(statuses)}`
      );
    }
  }
}

async function syncSubmittedFlows() {
  const docs = await VP.fetchSubmittedFlows();
  if (docs) {
    const flows = docs.map(doc => { return { parliamentId: `${doc.pobj}` } });
    await updateParliamentFlowStatus(
      flows,
      PARLIAMENT_FLOW_STATUSES.BEING_HANDLED
    );
  }
}

async function syncIncomingFlows() {
  const docs = await VP.fetchIncomingFlows();
  if (!docs?.length) {
    return;
  }
  const saveFile = async (file) => {
    const id = uuid();
    const filePath = `/share/${id}.${file.extension}`;
    fs.writeFileSync(filePath, file.base64, 'base64');
    const fileSize = fs.statSync(filePath).size;

    return await createFile(
      filePath,
      file.fileName,
      fileSize,
      file.extension,
      file.mimeType,
    );
  };

  let accessLevelMapping = {}
  accessLevelMapping[DOCUMENT_TYPES.DECREET] = ACCESS_LEVELS.PUBLIEK;
  accessLevelMapping[DOCUMENT_TYPES.RESOLUTIE] = ACCESS_LEVELS.PUBLIEK;
  accessLevelMapping[DOCUMENT_TYPES.MOTIE] = ACCESS_LEVELS.PUBLIEK;
  accessLevelMapping[DOCUMENT_TYPES.VERWIJZINGSFICHE] = ACCESS_LEVELS.INTERN_SECRETARIE;
  accessLevelMapping[DOCUMENT_TYPES.BIJLAGE] = ACCESS_LEVELS.INTERN_OVERHEID;

  const createPieces = async (doc, parliamentSubcaseUri, subcaseUri) => {

    const retrievalActivityUri = await createRetrievalActivity(parliamentSubcaseUri, subcaseUri, doc.themes);
    const pieces = [];
    for (const file of doc.files) {
      const representations = file.representations;

      // Try and find a Word and a PDF file
      const pdf = representations.find((r) => r.mimeType === 'application/pdf');
      const word = representations.find((r) => r.mimeType === 'application/vnd.openxmlformats-officedocument.wordprocessingml.document');
      const comment = representations.map((r) => r.comment?.trim()).filter((c) => c?.length).join(' - ');

      if (representations.length === 2 && pdf && word) {
        // We can create one piece with a source and derived file
        const { pieceUri } = await createDocumentContainerAndPiece(doc.shortTitle, file.documentType, accessLevelMapping[file.documentType]);
        const pdfUri = await saveFile(pdf);
        const wordUri = await saveFile(word);
        await linkDerivedFileToSourceFile(pdfUri, wordUri);
        await linkFileToPiece(wordUri, pieceUri);
        await createRetrievedPiece(retrievalActivityUri, doc.shortTitle, pieceUri, {
          pdfUri, pdfPfls: pdf.pfls,
          wordUri, wordPfls: word.pfls,
          comment,
        });
        pieces.push({ uri: pieceUri, files: [ { pfls: pdf.pfls, uri: pdfUri }, { pdfls: word.pfls, uri: wordUri } ] });
      } else if (representations.length === 1 && pdf) {
        // Create a single piece with the shortTitle as its name
        const { pieceUri } = await createDocumentContainerAndPiece(doc.shortTitle, file.documentType, accessLevelMapping[file.documentType]);
        const fileUri = await saveFile(pdf);
        await linkFileToPiece(fileUri, pieceUri);
        await createRetrievedPiece(retrievalActivityUri, doc.shortTitle, pieceUri, {
          pdfUri: fileUri, pdfPfls: pdf.pfls,
          comment,
        });
        pieces.push({ uri: pieceUri, files: [ { pfls: pdf.pfls, uri: fileUri }] });
      } else {
        // Create a separate piece for every file
        for (const representation of representations) {
          const { pieceUri } = await createDocumentContainerAndPiece(file.fileNameWithoutExtension, file.documentType, accessLevelMapping[file.documentType]);
          const fileUri = await saveFile(representation);
          await linkFileToPiece(fileUri, pieceUri);
          await createRetrievedPiece(retrievalActivityUri, representation.fileName, pieceUri, {
            pdfUri: fileUri, pdfPfls: representations[0].pfls, comment,
          });
          pieces.push({ uri: pieceUri, files: [ { pfls: representation.pfls, uri: fileUri }] });
        }
      }
    }

    await createSubmissionActivity(subcaseUri, pieces.map((p) => p.uri));
    return pieces;
  }

  for (const doc of docs) {
    const pobj = doc.pobj;
    const title = doc.title;
    const shortTitle = doc.shortTitle;
    const openingDate = doc.openingDate;
    const subcaseType = doc.subcaseType
    const agendaItemType = doc.agendaItemType
    let decisionmakingFlowId = null;
    let subcaseId = null;
    if (!await pobjIsKnown(pobj)) {
      // Create parliament flow, retrieval-activity, decisionmaking flow, case, subcase, pieces, files, etc.
      const {
        decisionmakingFlowUri,
        decisionmakingFlowId: _decisionmakingFlowId,
        caseUri,
        subcaseUri,
        subcaseId: _subcaseId,
      } = await createCaseDecisionmakingFlowAndSubcase(title, shortTitle, openingDate, subcaseType, agendaItemType);

      decisionmakingFlowId = _decisionmakingFlowId;
      subcaseId = _subcaseId;

      const parliamentFlowUri = await createParliamentFlow(pobj, decisionmakingFlowUri, PARLIAMENT_FLOW_STATUSES.RECEIVED, true);
      const parliamentSubcase = await createParliamentSubcase(parliamentFlowUri, true);

      const pieces = await createPieces(doc, parliamentSubcase, subcaseUri);
      await VP.notifyReceivedDocument(VP.generateNotificationPayload({ pobj, uri: decisionmakingFlowUri, case: caseUri }, pieces));
    } else {
      const { parliamentSubcase } = await getParliamentSubcaseFromPobj(pobj);
      const result = await getGeneratedSubcaseFromPobj(pobj);
      let decisionmakingFlow = doc.uri;
      let subcase, _case;
      if (result) {
        subcase = result.subcase;
        subcaseId = result.subcaseId;
        _case = result.case;
        decisionmakingFlow = result.decisionmakingFlow;
        decisionmakingFlowId = result.decisionmakingFlowId;
      } else {
        // Create subcase
        const subcaseResult = await createSubcase(title,shortTitle, subcaseType, agendaItemType, decisionmakingFlow);
        subcase = subcaseResult.subcaseUri;
        subcaseId = subcaseResult.subcaseId;

        _case = await getCaseFromDecisionmakingFlow(decisionmakingFlow);
        decisionmakingFlowId = await getDecisionmakingFlowId(decisionmakingFlow);
      }

      const pieces = [];
      const newPieces = [];
      const retrievalActivityUri = await createRetrievalActivity(parliamentSubcase, subcase, doc.themes);
      for (const file of doc.files) {
        const representations = file.representations;
        for (const representation of representations) {
          if (await pflsIsKnown(representation.pfls)) {
            // We already know this exact file? Skip the flow
            console.warn(
              "Incoming VP case has a pfls we already know and we won't handle it again"
                + ` pobj: "${pobj}" pfls: "${representation.pfls}" piece URI from VP: <${representation.uri}>`
            );
            continue;
          }
          if (representation.uri && await fileIsKnown(representation.uri)) {
            const pieceUri = await getPieceFromFile(representation.uri);
            if (await pieceIsOnFinalMeeting(pieceUri)) {
              // Log that this is on a final meeting and do nothing
              console.warn(
                'Incoming VP case has updates for a piece that is on a closed meeting'
                  + ` pobj: "${pobj}" piece URI: <${pieceUri}>`
              );
              continue;
            } else {
              const fileUri = await saveFile(representation);
              await moveDerivedAndSourceLinks(representation.uri, fileUri);
              await deleteFile(representation.uri);
              await linkFileToPiece(fileUri, pieceUri);
              await createRetrievedPiece(retrievalActivityUri, representation.fileName, pieceUri, {
                pdfUri: fileUri, pdfPfls: representation.pfls,
                comment,
              });
              pieces.push({ uri: pieceUri, files: [ { pfls: representation.pfls, uri: fileUri }] });
            }
          } else {
            const { pieceUri } = await createDocumentContainerAndPiece(file.fileNameWithoutExtension, file.documentType, accessLevelMapping[file.documentType]);
            const fileUri = await saveFile(representation);
            await linkFileToPiece(fileUri, pieceUri);
            await createRetrievedPiece(retrievalActivityUri, representation.fileName, pieceUri, {
              pdfUri: fileUri, pdfPfls: representation.pfls,
              comment,
            });
            newPieces.push({ uri: pieceUri, files: [ { pfls: representation.pfls, uri: fileUri }] });
            pieces.push({ uri: pieceUri, files: [ { pfls: representation.pfls, uri: fileUri }] });
          }
        }
      }
      if (newPieces.length) {
        await createSubmissionActivity(subcase, newPieces.map((p) => p.uri));
      }
      if (pieces.length) {
        await VP.notifyReceivedDocument(VP.generateNotificationPayload({ pobj, uri: decisionmakingFlow, case: _case }, pieces));
      }
    }
    const caseUrl = `${KALEIDOS_HOST_URL}dossiers/${decisionmakingFlowId}/deeldossiers`;
    const subcaseUrl = `${KALEIDOS_HOST_URL}dossiers/${decisionmakingFlowId}/deeldossiers/${subcaseId}`;
    await createEmail("Nieuwe documenten van het Vlaams Parlement", `Het Vlaams Parlement heeft nieuwe documenten doorgestuurd.

Ze zijn beschikbaar in het dossier ${caseUrl} in de procedurestap ${subcaseUrl}.`);
  }
}

export { syncFlowsByStatus, syncSubmittedFlows, syncIncomingFlows };
