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
  updateParliamentIds
} from "./parliament-flow";
import {
  KALEIDOS_HOST_URL,
  PARLIAMENT_FLOW_STATUSES,
  VP_PARLIAMENT_FLOW_STATUSES,
  DOCUMENT_TYPES,
  ACCESS_LEVELS,
  SUBCASE_TYPES
} from "../config";
import {
  createCaseDecisionmakingFlowAndSubcase,
  createSubcase,
  createSubmissionActivity,
  getCaseFromDecisionmakingFlow,
  getDecisionmakingFlowId,
  getLatestGovernmentAreas,
  getLatestSubcase,
  getCalculatedMandatees,
  getActiveMinisterPresident
} from "./decisionmaking-flow";
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
async function syncFlowsByStatus(statuses, isSudo) {
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
          isSudo
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

async function syncSubmittedFlows(isSudo) {
  const docs = await VP.fetchSubmittedFlows();
  if (docs) {
    const parliamentIdChanges = docs
      .filter(({ pobj_vorig }) => pobj_vorig)
      .map(({ pobj, pobj_vorig }) => ({ oldId: pobj_vorig, newId: pobj }));
    if (parliamentIdChanges?.length > 0) {
      await updateParliamentIds(parliamentIdChanges);
    }

    const flows = docs.map(doc => { return { parliamentId: `${doc.pobj}` } });
    await updateParliamentFlowStatus(
      flows,
      PARLIAMENT_FLOW_STATUSES.BEING_HANDLED,
      isSudo
    );
  }
}

async function syncIncomingFlows(isSudo) {
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
      isSudo
    );
  };

  let accessLevelMapping = {}
  accessLevelMapping[DOCUMENT_TYPES.DECREET] = ACCESS_LEVELS.PUBLIEK;
  accessLevelMapping[DOCUMENT_TYPES.RESOLUTIE] = ACCESS_LEVELS.PUBLIEK;
  accessLevelMapping[DOCUMENT_TYPES.MOTIE] = ACCESS_LEVELS.PUBLIEK;
  accessLevelMapping[DOCUMENT_TYPES.VERWIJZINGSFICHE] = ACCESS_LEVELS.INTERN_SECRETARIE;
  accessLevelMapping[DOCUMENT_TYPES.BIJLAGE] = ACCESS_LEVELS.PUBLIEK;

  const createPieces = async (doc, parliamentSubcaseUri, subcaseUri, isSudo) => {

    const retrievalActivityUri = await createRetrievalActivity(
      parliamentSubcaseUri,
      subcaseUri,
      doc.authorityDomain,
      doc.themes,
      doc.openingDate,
      isSudo
    );
    const pieces = [];
    for (const file of doc.files) {
      const representations = file.representations;

      // Try and find a Word and a PDF file
      const pdf = representations.find((r) => r.mimeType === 'application/pdf');
      const word = representations.find((r) => r.mimeType === 'application/vnd.openxmlformats-officedocument.wordprocessingml.document');
      const comment = representations.map((r) => r.comment?.trim()).filter((c) => c?.length).join(' - ');

      if (representations.length === 2 && pdf && word) {
        // We can create one piece with a source and derived file
        const { pieceUri } = await createDocumentContainerAndPiece(
          file.fileNameWithoutExtension,
          file.documentType,
          accessLevelMapping[file.documentType],
          isSudo
        );
        const pdfUri = await saveFile(pdf);
        const wordUri = await saveFile(word);
        await linkDerivedFileToSourceFile(pdfUri, wordUri, isSudo);
        await linkFileToPiece(wordUri, pieceUri, isSudo);
        await createRetrievedPiece(
          retrievalActivityUri,
          file.fileNameWithoutExtension,
          pieceUri,
          {
            pdfUri, pdfPfls: pdf.pfls,
            wordUri, wordPfls: word.pfls,
            comment
          },
          isSudo
        );
        pieces.push({ uri: pieceUri, files: [ { pfls: pdf.pfls, uri: pdfUri }, { pfls: word.pfls, uri: wordUri } ] });
      } else if (representations.length === 1 && pdf) {
        // Create a single piece with the shortTitle as its name
        const { pieceUri } = await createDocumentContainerAndPiece(
          file.fileNameWithoutExtension,
          file.documentType,
          accessLevelMapping[file.documentType],
          isSudo
        );
        const fileUri = await saveFile(pdf);
        await linkFileToPiece(fileUri, pieceUri, isSudo);
        await createRetrievedPiece(
          retrievalActivityUri,
          file.fileNameWithoutExtension,
          pieceUri,
          {
            pdfUri: fileUri, pdfPfls: pdf.pfls, comment,
          },
          isSudo
        );
        pieces.push({ uri: pieceUri, files: [ { pfls: pdf.pfls, uri: fileUri }] });
      } else {
        // Create a separate piece for every file
        for (const representation of representations) {
          const { pieceUri } = await createDocumentContainerAndPiece(
            file.fileNameWithoutExtension,
            file.documentType,
            accessLevelMapping[file.documentType],
            isSudo
          );
          const fileUri = await saveFile(representation);
          await linkFileToPiece(fileUri, pieceUri, isSudo);
          await createRetrievedPiece(
            retrievalActivityUri,
            representation.fileName,
            pieceUri,
            {
              pdfUri: fileUri, pdfPfls: representation.pfls, comment,
            },
            isSudo
          );
          pieces.push({ uri: pieceUri, files: [ { pfls: representation.pfls, uri: fileUri }] });
        }
      }
    }

    await createSubmissionActivity(subcaseUri, pieces.map((p) => p.uri), isSudo);
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
      } = await createCaseDecisionmakingFlowAndSubcase(title, shortTitle, openingDate, subcaseType, agendaItemType, isSudo);

      decisionmakingFlowId = _decisionmakingFlowId;
      subcaseId = _subcaseId;

      const parliamentFlowUri = await createParliamentFlow(pobj, decisionmakingFlowUri, PARLIAMENT_FLOW_STATUSES.RECEIVED, isSudo);
      const parliamentSubcase = await createParliamentSubcase(parliamentFlowUri, isSudo);

      const pieces = await createPieces(doc, parliamentSubcase, subcaseUri, isSudo);
      await VP.notifyReceivedDocument(VP.generateNotificationPayload({ pobj, uri: decisionmakingFlowUri, case: caseUri }, pieces));
    } else {
      /* The pobj is known, this is either an update to an already processed
         flow, or it's the response to a flow we sent to the VP */
      const { parliamentSubcase } = await getParliamentSubcaseFromPobj(pobj, isSudo);

      // Fetch data about the Kaleidos subcase the incoming pieces will live in
      const result = await getGeneratedSubcaseFromPobj(pobj, isSudo);
      let decisionmakingFlow = doc.uri;
      let subcase, _case;
      if (result) {
        subcase = result.subcase;
        subcaseId = result.subcaseId;
        _case = result.case;
        decisionmakingFlow = result.decisionmakingFlow;
        decisionmakingFlowId = result.decisionmakingFlowId;
      } else {
        // Find governmentAreas of latest subcase (any type)
        const { uri: latestSubcase } = await getLatestSubcase(decisionmakingFlow);
        const latestSubcaseGovernmentAreas = latestSubcase ? await getLatestGovernmentAreas(latestSubcase) : [];
        // Find mandatees of previous definitive subcase, only if we are going to make a ratification subcase
        let definitiveMandatees = [];
        if (subcaseType === SUBCASE_TYPES.BEKRACHTIGING_VLAAMSE_REGERING) {
          const { uri: latestDefinitiveSubcase } = await getLatestSubcase(decisionmakingFlow, SUBCASE_TYPES.DEFINITIEVE_GOEDKEURING);
          const mandatees = latestDefinitiveSubcase ? await getCalculatedMandatees(latestDefinitiveSubcase) : [];
          // add PM at all costs
          const currentMinisterPresident = await getActiveMinisterPresident();
          mandatees.push(currentMinisterPresident);
          definitiveMandatees = [...new Set(mandatees)];
        }
        // Create subcase
        const subcaseResult = await createSubcase(title, shortTitle, subcaseType, agendaItemType, decisionmakingFlow, definitiveMandatees, latestSubcaseGovernmentAreas, isSudo);
        subcase = subcaseResult.subcaseUri;
        subcaseId = subcaseResult.subcaseId;

        _case = await getCaseFromDecisionmakingFlow(decisionmakingFlow, isSudo);
        decisionmakingFlowId = await getDecisionmakingFlowId(decisionmakingFlow, isSudo);
      }

      const pieces = [];
      const newPieces = [];
      const retrievalActivityUri = await createRetrievalActivity(
        parliamentSubcase,
        subcase,
        doc.authorityDomain,
        doc.themes,
        doc.openingDate,
        isSudo
      );
      for (const file of doc.files) {
        /* We're dealing with a known pobj, which means we can be in a number
           of different cases:
            - The incoming pfls is known: skip this file, as we don't want to
              reprocess it
            - The incoming file has a kaleidos-id (URI) we know about: if the
              file is not on a final meeting, replace it
            - Nothing about the incoming file is known: create a new piece and
              correctly link the file.
           In the last case, if the file contains multiple representations
           (e.g DOCX and PDF) we need to put them into a single piece. */

        const validRepresentations = [];
        const representations = file.representations;
        for (const representation of representations) {
          if (await pflsIsKnown(representation.pfls)) {
            // We already know this exact file? Skip it
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
              // Replace an existing file
              const fileUri = await saveFile(representation);
              await moveDerivedAndSourceLinks(representation.uri, fileUri, isSudo);
              await deleteFile(representation.uri, isSudo);
              await linkFileToPiece(fileUri, pieceUri, isSudo);
              await createRetrievedPiece(
                retrievalActivityUri,
                representation.fileName,
                pieceUri, {
                  pdfUri: fileUri, pdfPfls: representation.pfls,
                  comment: representation.comment,
                },
                isSudo
              );
              pieces.push({ uri: pieceUri, files: [ { pfls: representation.pfls, uri: fileUri }] });
              continue;
            }
          } else {
            // This representation was not known and is not replacing an
            // existing file, treat it as a new file, which we will
            // process later
            validRepresentations.push(representation);
          }
        }
        // Handle totally new files. Try and find a Word and a PDF file
        const pdf = validRepresentations.find((r) => r.mimeType === 'application/pdf');
        const word = validRepresentations.find((r) => r.mimeType === 'application/vnd.openxmlformats-officedocument.wordprocessingml.document');
        const comment = validRepresentations.map((r) => r.comment?.trim()).filter((c) => c?.length).join(' - ');
        if (validRepresentations.length === 2 && pdf && word) {
          // We can create one piece with a source and derived file
          const { pieceUri } = await createDocumentContainerAndPiece(
            file.fileNameWithoutExtension,
            file.documentType,
            accessLevelMapping[file.documentType],
            isSudo
          );
          const pdfUri = await saveFile(pdf);
          const wordUri = await saveFile(word);
          await linkDerivedFileToSourceFile(pdfUri, wordUri, isSudo);
          await linkFileToPiece(wordUri, pieceUri, isSudo);
          await createRetrievedPiece(
            retrievalActivityUri,
            file.fileNameWithoutExtension,
            pieceUri,
            {
              pdfUri, pdfPfls: pdf.pfls,
              wordUri, wordPfls: word.pfls,
              comment
            },
            isSudo
          );
          newPieces.push({ uri: pieceUri, files: [ { pfls: pdf.pfls, uri: pdfUri }, { pfls: word.pfls, uri: wordUri } ] });
          pieces.push({ uri: pieceUri, files: [ { pfls: pdf.pfls, uri: pdfUri }, { pfls: word.pfls, uri: wordUri } ] });
        } else if (validRepresentations.length === 1 && pdf) {
          // Create a single piece with the shortTitle as its name
          const { pieceUri } = await createDocumentContainerAndPiece(
            file.fileNameWithoutExtension,
            file.documentType,
            accessLevelMapping[file.documentType],
            isSudo
          );
          const fileUri = await saveFile(pdf);
          await linkFileToPiece(fileUri, pieceUri, isSudo);
          await createRetrievedPiece(
            retrievalActivityUri,
            file.fileNameWithoutExtension,
            pieceUri,
            {
              pdfUri: fileUri, pdfPfls: pdf.pfls, comment,
            },
            isSudo
          );
          newPieces.push({ uri: pieceUri, files: [ { pfls: pdf.pfls, uri: fileUri }] });
          pieces.push({ uri: pieceUri, files: [ { pfls: pdf.pfls, uri: fileUri }] });
        } else {
          // Create a separate piece for every file
          for (const representation of validRepresentations) {
            const { pieceUri } = await createDocumentContainerAndPiece(
              file.fileNameWithoutExtension,
              file.documentType,
              accessLevelMapping[file.documentType],
              isSudo
            );
            const fileUri = await saveFile(representation);
            await linkFileToPiece(fileUri, pieceUri, isSudo);
            await createRetrievedPiece(
              retrievalActivityUri,
              representation.fileName,
              pieceUri,
              {
                pdfUri: fileUri, pdfPfls: representation.pfls, comment,
              },
              isSudo
            );
            newPieces.push({ uri: pieceUri, files: [ { pfls: representation.pfls, uri: fileUri }] });
            pieces.push({ uri: pieceUri, files: [ { pfls: representation.pfls, uri: fileUri }] });
          }
        }
      }
      if (newPieces.length) {
        await createSubmissionActivity(subcase, newPieces.map((p) => p.uri), isSudo);
      }
      if (pieces.length) {
        await VP.notifyReceivedDocument(VP.generateNotificationPayload({ pobj, uri: decisionmakingFlow, case: _case }, pieces));
      }
    }
    const caseUrl = `${KALEIDOS_HOST_URL}dossiers/${decisionmakingFlowId}/deeldossiers`;
    const subcaseUrl = `${KALEIDOS_HOST_URL}dossiers/${decisionmakingFlowId}/deeldossiers/${subcaseId}`;
    await createEmail("Nieuwe documenten van het Vlaams Parlement", `Het Vlaams Parlement heeft nieuwe documenten doorgestuurd.

Voor het dossier "${shortTitle}" zijn ze beschikbaar op ${caseUrl} in de procedurestap ${subcaseUrl}.`);
  }
}

export { syncFlowsByStatus, syncSubmittedFlows, syncIncomingFlows };
