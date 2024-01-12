import VP from "./vp";
import {
  getFlowsByStatus,
  updateParliamentFlowStatus,
} from "./parliament-flow";
import { PARLIAMENT_FLOW_STATUSES, VP_PARLIAMENT_FLOW_STATUSES } from "../config";

/**
 * For all flows in Kaleidos that have a given status, it checks for
 * status updates on the VP API and updates their status in
 * Kaleidos accordingly.
 */
async function syncFlowsByStatus(statuses) {
  const pendingFlows = await getFlowsByStatus(statuses);
  await Promise.all(
    pendingFlows.map(async (flow) => {
      let statuses;
      try {
        statuses = await VP.getStatusForFlow(flow.parliamentId);
      } catch (error) {
        console.error(error);
      }
      if (!statuses?.statussen) {
        // note: We can't do this because there will also no status when the
        // case has not been ingediend
        // await updateParliamentFlowStatus(
        //   flow.uri,
        //   PARLIAMENT_FLOW_STATUSES.VP_ERROR,
        //   true
        // );
        console.warn(
          `Invalid response from status API for flow with uri ${flow.uri}`
        );
        return;
      }
      if (
        statuses.statussen.find(
          (statusChange) =>
            statusChange.status === VP_PARLIAMENT_FLOW_STATUSES.BEING_HANDLED
        )
      ) {
        await updateParliamentFlowStatus(
          flow.uri,
          PARLIAMENT_FLOW_STATUSES.BEING_HANDLED,
          true
        );
        console.log("dossier kan behandeld worden in commissie");
      }
    })
  );
}

export { syncFlowsByStatus };
