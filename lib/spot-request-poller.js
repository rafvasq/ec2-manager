const assert = require('assert');
const {runAWSRequest} = require('./aws-request');
const Iterate = require('taskcluster-lib-iterate');

const log = require('./log');

const BATCH_SIZE = 100;

class SpotRequestPoller {

  constructor({ec2, regions, runaws = runAWSRequest, spotPollDelay = 25, state}) {
    assert(typeof ec2 === 'object');
    assert(Array.isArray(regions));
    regions.forEach(region => assert(typeof region === 'string'));
    assert(typeof state === 'object');

    this.ec2 = ec2;
    this.regions = regions;
    this.state = state;
    this.runaws = runaws;

    this.iterator = new Iterate({
      maxIterationTime: 1000 * 60 * 15,
      watchDog: 1000 * 60 * 15,
      maxFailures: 10,
      waitTime: spotPollDelay,
      handler: async(watchdog) => {
        try {
          await this.poll();
        } catch (err) {
          console.dir(err.stack || err);
          monitor.reportError(err, 'Error polling pricing data');
        }
      },
    });
  };

  start() {
    return this.iterator.start();
  }

  stop() {
    return this.iterator.stop();
  }

  async poll() {
    await Promise.all(this.regions.map(region => this._poll(region)));
  }

  async _poll(region) {
    assert(typeof region === 'string');

    let idsToPoll = await this.state.spotRequestsToPoll({region});
    if (idsToPoll.length === 0) {
      log.trace({region}, 'No Spot Requests to poll in this region');
      return;
    }

    log.info({ids: idsToPoll, region}, 'Polling spot requests');

    let nBatch = Math.ceil(idsToPoll.length / BATCH_SIZE);
    for (let i = 0 ; i < nBatch ; i++) {
      let ids = idsToPoll.slice(i, i + BATCH_SIZE);
      let result = await this.runaws(this.ec2, 'describeSpotInstanceRequests', {
        SpotInstanceRequestIds: ids,
      });

      let idsToKill = [];

      for (let spotRequest of result.SpotInstanceRequests) {
        let id = spotRequest.SpotInstanceRequestId;
        let requestState = spotRequest.State;
        let status = spotRequest.Status.Code;
        // NOTE:
        // The states which we should continue to poll are 'pending-evaluation' and
        // 'pending-fulfillment'.  For the other states, we should delete them.  For
        // those states which are not open and pending-* and not active, we should
        // also request those instances be killed by the EC2 api because we don't
        // want to wait around for them.
        // I guess this could've been a switch but I'd rather not nest those
        const infoObj = {
          id,
          state: requestState,
          status,
        };
        if (requestState === 'open') {
          if (status === 'pending-evaluation' || status === 'pending-fulfillment') {
            await this.state.updateSpotRequestState({id, region, state: requestState, status});
            log.info(infoObj, 'Updated state of spot request');
          } else {
            // NOTE: we'll delete from the database only after the killing has been done
            // this is done here so that we can avoid having zombies
            idsToKill.push(id);
            log.info(infoObj, 'Killing spot request because it is in a bad state');
          }
        } else {
          await this.state.removeSpotRequest({region, id});
          log.info(infoObj, 'No longer tracking spot request');
        }
      }

      if (idsToKill.length > 0) {
        const killed = await this.runaws(this.ec2, 'cancelSpotInstanceRequests', {
          SpotInstanceRequestIds: idsToKill,
        });
        const idsKilled = killed.CancelledSpotInstanceRequests.map(x => x.SpotInstanceRequestId);
        await Promise.all(idsKilled.map(id => this.state.removeSpotRequest({region, id})));

        log.info({idsKilled}, 'killed spot requests');
      }
    }
  }
}

module.exports = {SpotRequestPoller};
