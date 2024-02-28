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
import { KALEIDOS_HOST_URL, PARLIAMENT_FLOW_STATUSES, VP_PARLIAMENT_FLOW_STATUSES } from "../config";
import { createCaseDecisionmakingFlowAndSubcase, createSubmissionActivity } from "./decisionmaking-flow";
import {
  createFile,
  deleteFile,
  fileIsKnown,
  linkFileToPiece,
  linkDerivedFileToSourceFile,
  pieceIsOnFinalMeeting,
  createDocumentContainerAndPiece,
  getPieceFromFile,
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
  const createFiles = async (doc, parliamentSubcaseUri, subcaseUri, pieceUri, verwijzingsfichePieceUri) => {
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
    // Store files on disk & in metadata
    const pdfUri = await saveFile(doc.document.pdf);
    const wordUri = await saveFile(doc.document.word);
    const verwijzingsficheUri = await saveFile(doc.verwijzingsfiche.pdf);
    // Link new files
    await linkDerivedFileToSourceFile(pdfUri, wordUri);
    await linkFileToPiece(wordUri, pieceUri);

    await linkFileToPiece(verwijzingsficheUri, verwijzingsfichePieceUri);

    const activity = await createRetrievalActivity(parliamentSubcaseUri, subcaseUri, doc.themes);
    await createRetrievedPiece(activity, doc.shortTitle, pieceUri, {
      pdfUri, pdfPfls: doc.document.pdf.pfls,
      wordUri, wordPfls: doc.document.word.pfls,
      comment: doc.comment
    });
    const verwijzingsficheTitle = `${doc.shortTitle} - verwijzingsfiche`
    await createRetrievedPiece(activity, verwijzingsficheTitle, verwijzingsfichePieceUri, {
      pdfUri: verwijzingsficheUri, pdfPfls: doc.verwijzingsfiche.pdf.pfls,
      comment: doc.comment,
    });
  };
  const createPieces = async (doc, parliamentSubcaseUri, subcaseUri) => {
    const { pieceUri } = await createDocumentContainerAndPiece(doc.shortTitle, doc.document.pdf.documentType);

    const verwijzingsficheTitle = `${doc.shortTitle} - verwijzingsfiche`
    const { pieceUri: verwijzingsfichePieceUri } = await createDocumentContainerAndPiece(verwijzingsficheTitle, doc.verwijzingsfiche.pdf.documentType);

    await createFiles(doc, parliamentSubcaseUri, subcaseUri, pieceUri, verwijzingsfichePieceUri);

    await createSubmissionActivity(subcaseUri, [pieceUri, verwijzingsfichePieceUri]);
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
        subcaseUri,
        subcaseId: _subcaseId,
      } = await createCaseDecisionmakingFlowAndSubcase(title, shortTitle, openingDate, subcaseType, agendaItemType);

      decisionmakingFlowId = _decisionmakingFlowId;
      subcaseId = _subcaseId;

      const parliamentFlowUri = await createParliamentFlow(pobj, decisionmakingFlowUri, PARLIAMENT_FLOW_STATUSES.BEING_HANDLED, true);
      const parliamentSubcase = await createParliamentSubcase(parliamentFlowUri, true);

      await createPieces(doc, parliamentSubcase, subcaseUri);
    } else {
      if (await pflsIsKnown(doc.document.pdf.pfls)) {
        // We already know this exact file? Skip the flow
        console.warn(
          "Incoming VP case has a pfls we already know and we won't handle it again"
            + ` pobj: "${pobj}" pfls: "${doc.document.pdf.pfls}" piece URI from VP: <${doc.document.pdf.uri}>`
        );
        continue;
      }

      const { parliamentSubcase } = await getParliamentSubcaseFromPobj(pobj);
      const {
        subcase,
        subcaseId: _subcaseId,
        decisionmakingFlowId: _decisionmakingFlowId,
      } = await getGeneratedSubcaseFromPobj(pobj);

      decisionmakingFlowId = _decisionmakingFlowId;
      subcaseId = _subcaseId;

      if (doc.document.pdf.uri && await fileIsKnown(doc.document.pdf.uri)) {
        const pieceUri = await getPieceFromFile(doc.document.pdf.uri);
        if (await pieceIsOnFinalMeeting(pieceUri)) {
          // Log that this is on a final meeting and do nothing
          console.warn(
            'Incoming VP case has updates for a piece that is on a closed meeting'
              + ` pobj: "${pobj}" piece URI: <${pieceUri}>`
          );
          continue;
        } else {
          const verwijzingsfichePieceUri = await getPieceFromFile(doc.verwijzingsfiche.pdf.uri);
          // Delete old files
          await deleteFile(doc.document.pdf.uri);
          await deleteFile(doc.document.word.uri);
          await deleteFile(doc.verwijzingsfiche.pdf.uri);
          // Create new files
          await createFiles(doc, parliamentSubcase, subcase, pieceUri, verwijzingsfichePieceUri);
        }
      } else {
        await createPieces(doc, parliamentSubcase, subcase);
      }
    }
    const caseUrl = `${KALEIDOS_HOST_URL}dossiers/${decisionmakingFlowId}`;
    const subcaseUrl = `${KALEIDOS_HOST_URL}dossiers/${decisionmakingFlowId}/deeldossiers/${subcaseId}`;
    await createEmail("Nieuwe documenten van het Vlaams Parlement", `Dag,

Er zijn nieuwe documenten beschikbaar in het dossier ${caseUrl} en de procedurestap ${subcaseUrl}, komende van het Vlaams Parlement.

Vriendelijke groeten,
Kaleidos`);
  }
}

export { syncFlowsByStatus, syncSubmittedFlows, syncIncomingFlows };
