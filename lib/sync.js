import VP from "./vp";
import { getIncompleteParliamentFlows } from "./parliament-flow";

/**
 * For all incomplete flows in Kaleidos, it checks for status updates
 * on the VP API and updates their status in Kaleidos accordingly.
 */
async function syncIncompleteFlows() {
  const pendingFlows = await getIncompleteParliamentFlows();
  await Promise.all(
    pendingFlows.map(async (flow) => {
      let statuses;
      try {
        statuses = await VP.getStatusForFlow(flow.parliamentId);
      } catch (error) {
        console.error(error);
      }
      console.log(statuses);
      if (!statuses?.statussen) {
        // await updateParliamentFlowStatus(
        //   flow.uri,
        //   PARLIAMENT_FLOW_STATUSES.ERROR,
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
        // await updateParliamentFlowStatus(
        //   flow.uri,
        //   PARLIAMENT_FLOW_STATUSES.BEING_HANDLED,
        //   true
        // );
        console.log("dossier kan behandeld worden in commissie");
      }
    })
  );
}

export {
  syncIncompleteFlows
}