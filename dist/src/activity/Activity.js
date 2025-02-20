"use strict";

Object.defineProperty(exports, "__esModule", {
  value: true
});
exports.default = Activity;

var _ActivityExecution = _interopRequireDefault(require("./ActivityExecution"));

var _shared = require("../shared");

var _Api = require("../Api");

var _EventBroker = require("../EventBroker");

var _smqp = require("smqp");

var _messageHelper = require("../messageHelper");

function _interopRequireDefault(obj) { return obj && obj.__esModule ? obj : { default: obj }; }

function Activity(Behaviour, activityDef, context) {
  const {
    id,
    type = 'activity',
    name,
    parent: originalParent = {},
    behaviour = {},
    isParallelGateway,
    isSubProcess,
    triggeredByEvent,
    isThrowing
  } = activityDef;
  const parent = (0, _messageHelper.cloneParent)(originalParent);
  const {
    environment,
    getInboundSequenceFlows,
    getOutboundSequenceFlows
  } = context;
  const logger = environment.Logger(type.toLowerCase());
  const {
    step
  } = environment.settings;
  const {
    attachedTo: attachedToRef,
    ioSpecification: ioSpecificationDef,
    eventDefinitions
  } = behaviour;
  let attachedToActivity, attachedTo;

  if (attachedToRef) {
    attachedTo = attachedToRef.id;
    attachedToActivity = context.getActivityById(attachedToRef.id);
  }

  const inboundSequenceFlows = getInboundSequenceFlows(id) || [];
  const outboundSequenceFlows = getOutboundSequenceFlows(id) || [];
  const isStart = inboundSequenceFlows.length === 0 && !attachedTo && !triggeredByEvent;
  const isEnd = outboundSequenceFlows.length === 0;
  const isParallelJoin = inboundSequenceFlows.length > 1 && isParallelGateway;
  const isMultiInstance = !!behaviour.loopCharacteristics;
  let execution,
      initExecutionId,
      executionId,
      stateMessage,
      status,
      stopped = false,
      executeMessage,
      consumingRunQ;
  const inboundTriggers = attachedToActivity ? [attachedToActivity] : inboundSequenceFlows.slice();
  const inboundJoinFlows = [];
  let counters = {
    taken: 0,
    discarded: 0
  };
  const activityApi = {
    id,
    type,
    name,
    isEnd,
    isStart,
    isSubProcess,
    isThrowing,
    triggeredByEvent,
    parent: (0, _messageHelper.cloneParent)(parent),
    behaviour: { ...behaviour,
      eventDefinitions
    },
    attachedTo: attachedToActivity,
    environment,
    inbound: inboundSequenceFlows,
    outbound: outboundSequenceFlows,

    get counters() {
      return { ...counters
      };
    },

    get executionId() {
      return executionId;
    },

    get status() {
      return status;
    },

    get stopped() {
      return stopped;
    },

    get isRunning() {
      if (!consumingRunQ) return false;
      return !!status;
    },

    Behaviour,
    activate,
    deactivate,
    logger,
    discard,
    getApi,
    getActivityById,
    getState,
    init,
    recover,
    resume,
    run,
    shake,
    stop,
    next: step && next
  };
  const {
    broker,
    on,
    once,
    waitFor,
    emitFatal
  } = (0, _EventBroker.ActivityBroker)(activityApi);
  activityApi.on = on;
  activityApi.once = once;
  activityApi.waitFor = waitFor;
  activityApi.emitFatal = emitFatal;
  const runQ = broker.getQueue('run-q');
  const executionQ = broker.getQueue('execution-q');
  const formatRunQ = broker.getQueue('format-run-q');
  const inboundQ = broker.assertQueue('inbound-q', {
    durable: true,
    autoDelete: false
  });
  inboundTriggers.forEach(trigger => {
    if (trigger.isSequenceFlow) trigger.broker.subscribeTmp('event', 'flow.#', onInboundEvent, {
      noAck: true,
      consumerTag: `_inbound-${id}`
    });else trigger.broker.subscribeTmp('event', 'activity.#', onInboundEvent, {
      noAck: true,
      consumerTag: `_inbound-${id}`
    });
  });
  Object.defineProperty(activityApi, 'broker', {
    enumerable: true,
    get: () => broker
  });
  Object.defineProperty(activityApi, 'execution', {
    enumerable: true,
    get: () => execution
  });
  const extensions = context.loadExtensions(activityApi);
  Object.defineProperty(activityApi, 'extensions', {
    enumerable: true,
    get: () => extensions
  });
  const ioSpecification = ioSpecificationDef && ioSpecificationDef.Behaviour(activityApi, ioSpecificationDef, context);
  const loaedEventDefinitions = eventDefinitions && eventDefinitions.map(ed => ed.Behaviour(activityApi, ed, context));
  Object.defineProperty(activityApi, 'eventDefinitions', {
    enumerable: true,
    get: () => loaedEventDefinitions
  });
  return activityApi;

  function init(initContent) {
    initExecutionId = initExecutionId || (0, _shared.getUniqueId)(id);
    logger.debug(`<${id}> initialized with executionId <${initExecutionId}>`);
    publishEvent('init', createMessage({ ...initContent,
      executionId: initExecutionId
    }));
  }

  function run(runContent) {
    if (activityApi.isRunning) throw new Error(`activity <${id}> is already running`);
    executionId = initExecutionId || (0, _shared.getUniqueId)(id);
    consumeApi();
    initExecutionId = undefined;
    const content = createMessage({ ...runContent,
      executionId
    });
    broker.publish('run', 'run.enter', content);
    broker.publish('run', 'run.start', (0, _messageHelper.cloneContent)(content));
    consumeRunQ();
  }

  function createMessage(override = {}) {
    const result = { ...override,
      id,
      type,
      name,
      parent: (0, _messageHelper.cloneParent)(parent)
    };
    const flags = {
      isEnd,
      isStart,
      isSubProcess,
      isMultiInstance
    };

    for (const flag in flags) {
      if (flags[flag]) result[flag] = true;
    }

    if (attachedTo) result.attachedTo = { ...attachedTo
    };
    return result;
  }

  function recover(state) {
    if (activityApi.isRunning) throw new Error(`cannot recover running activity <${id}>`);
    if (!state) return;
    stopped = state.stopped;
    status = state.status;
    executionId = state.executionId;
    counters = state.counters && { ...counters,
      ...state.counters
    };

    if (state.execution) {
      execution = (0, _ActivityExecution.default)(activityApi, context).recover(state.execution);
    }

    broker.recover(state.broker);
  }

  function resume() {
    if (activityApi.isRunning) {
      throw new Error(`cannot resume running activity <${id}>`);
    }

    if (!status) return activate();
    stopped = false;
    consumeApi();
    const content = createMessage();
    broker.publish('run', 'run.resume', content, {
      persistent: false
    });
    consumeRunQ();
  }

  function discard(discardContent) {
    if (!status) return runDiscard(discardContent);
    if (execution && !execution.completed) return execution.discard();
    deactivateRunConsumers();
    runQ.purge();
    broker.publish('run', 'run.discard', (0, _messageHelper.cloneContent)(stateMessage.content));
    consumeRunQ();
  }

  function discardRun() {
    if (!status) return;
    if (execution && !execution.completed) return;

    switch (status) {
      case 'executing':
      case 'error':
      case 'discarded':
        return;
    }

    deactivateRunConsumers();
    runQ.purge();
    broker.publish('run', 'run.discard', (0, _messageHelper.cloneContent)(stateMessage.content));
    consumeRunQ();
  }

  function runDiscard(discardContent = {}) {
    executionId = initExecutionId || (0, _shared.getUniqueId)(id);
    consumeApi();
    initExecutionId = undefined;
    const content = createMessage({ ...discardContent,
      executionId
    });
    broker.publish('run', 'run.discard', content);
    consumeRunQ();
  }

  function stop() {
    if (!activityApi.isRunning) return;
    getApi().stop();
  }

  function activate() {
    if (isParallelJoin) {
      return inboundQ.consume(onJoinInbound, {
        consumerTag: '_run-on-inbound',
        prefetch: 1000
      });
    }

    return inboundQ.consume(onInbound, {
      consumerTag: '_run-on-inbound'
    });
  }

  function deactivate() {
    broker.cancel('_run-on-inbound');
    broker.cancel('_format-consumer');
  }

  function consumeRunQ() {
    if (consumingRunQ) return;
    consumingRunQ = true;
    runQ.assertConsumer(onRunMessage, {
      exclusive: true,
      consumerTag: '_activity-run'
    });
  }

  function consumeApi() {
    if (!executionId) return;
    broker.cancel('_activity-api');
    broker.subscribeTmp('api', `activity.*.${executionId}`, onApiMessage, {
      noAck: true,
      consumerTag: '_activity-api',
      priority: 100
    });
  }

  function deactivateRunConsumers() {
    broker.cancel('_activity-api');
    broker.cancel('_activity-run');
    broker.cancel('_activity-execution');
    consumingRunQ = false;
  }

  function onInboundEvent(routingKey, message) {
    const {
      fields,
      content,
      properties
    } = message;

    switch (routingKey) {
      case 'activity.enter':
      case 'activity.discard':
        {
          if (content.id === attachedToActivity.id) {
            inboundQ.queueMessage(fields, (0, _messageHelper.cloneContent)(content), properties);
          }

          break;
        }

      case 'flow.shake':
        {
          shakeOutbound(message);
          break;
        }

      case 'flow.take':
      case 'flow.discard':
        inboundQ.queueMessage(fields, (0, _messageHelper.cloneContent)(content), properties);
        break;
    }
  }

  function onInbound(routingKey, message) {
    message.ack();
    broker.cancel('_run-on-inbound');
    const content = message.content;
    const inbound = [(0, _messageHelper.cloneContent)(content)];

    switch (routingKey) {
      case 'flow.take':
      case 'activity.enter':
        run({
          message: content.message,
          inbound
        });
        break;

      case 'flow.discard':
      case 'activity.discard':
        {
          let discardSequence;
          if (content.discardSequence) discardSequence = content.discardSequence.slice();
          runDiscard({
            inbound,
            discardSequence
          });
          break;
        }
    }
  }

  function onJoinInbound(routingKey, message) {
    const touchedIds = inboundJoinFlows.map(msg => msg.content.id);
    const idx = touchedIds.indexOf(message.content.id);
    if (idx > -1) return;
    inboundJoinFlows.push(message);
    const allTouched = inboundJoinFlows.length === inboundTriggers.length;
    const remaining = inboundSequenceFlows.length - inboundJoinFlows.length;
    logger.debug(`<${id}> inbound ${message.content.action} from <${message.content.id}>, ${remaining} remaining`);
    if (!allTouched) return init({
      inbound: inboundJoinFlows.map(f => (0, _messageHelper.cloneContent)(f.content))
    });
    const evaluatedInbound = inboundJoinFlows.splice(0);
    let taken;
    const inbound = evaluatedInbound.map(im => {
      if (im.fields.routingKey === 'flow.take') taken = true;
      im.ack();
      return (0, _messageHelper.cloneContent)(im.content);
    });
    const discardSequence = !taken && evaluatedInbound.reduce((result, im) => {
      if (!im.content.discardSequence) return result;
      im.content.discardSequence.forEach(sourceId => {
        if (result.indexOf(sourceId) === -1) result.push(sourceId);
      });
      return result;
    }, []);
    broker.cancel('_run-on-inbound');
    if (!taken) return runDiscard({
      inbound,
      discardSequence
    });
    return run({
      inbound
    });
  }

  function onRunMessage(routingKey, message, messageProperties) {
    switch (routingKey) {
      case 'run.next':
        return continueRunMessage(routingKey, message, messageProperties);

      case 'run.resume':
        {
          return onResumeMessage();
        }
    }

    return formatRunMessage(formatRunQ, message, (err, formattedContent) => {
      if (err) return broker.publish('run', 'run.error', err);
      message.content = formattedContent;
      continueRunMessage(routingKey, message, messageProperties);
    });

    function onResumeMessage() {
      message.ack();
      const {
        fields
      } = stateMessage;

      switch (fields.routingKey) {
        case 'run.enter':
        case 'run.start':
        case 'run.discarded':
        case 'run.end':
        case 'run.leave':
          break;

        default:
          return;
      }

      if (!fields.redelivered) return;
      logger.debug(`<${id}> resume from ${status}`);
      return broker.publish('run', fields.routingKey, (0, _messageHelper.cloneContent)(stateMessage.content), stateMessage.properties);
    }
  }

  function continueRunMessage(routingKey, message) {
    broker.cancel('_format-consumer');
    const {
      fields,
      content: originalContent,
      ack
    } = message;
    const isRedelivered = fields.redelivered;
    const content = (0, _messageHelper.cloneContent)(originalContent);
    stateMessage = message;

    switch (routingKey) {
      case 'run.enter':
        {
          logger.debug(`<${id}> enter`, isRedelivered ? 'redelivered' : '');
          status = 'entered';

          if (!isRedelivered) {
            execution = undefined;
          }

          if (extensions) extensions.activate(message);
          if (ioSpecification) ioSpecification.activate(message);
          if (!isRedelivered) publishEvent('enter', content);
          break;
        }

      case 'run.discard':
        {
          logger.debug(`<${id}> discard`, isRedelivered ? 'redelivered' : '');
          status = 'discard';
          execution = undefined;
          if (extensions) extensions.activate(message);
          if (ioSpecification) ioSpecification.activate(message);

          if (!isRedelivered) {
            broker.publish('run', 'run.discarded', content);
            publishEvent('discard', content);
          }

          break;
        }

      case 'run.start':
        {
          logger.debug(`<${id}> start`, isRedelivered ? 'redelivered' : '');
          status = 'started';

          if (!isRedelivered) {
            broker.publish('run', 'run.execute', content);
            publishEvent('start', content);
          }

          break;
        }

      case 'run.execute':
        {
          status = 'executing';
          executeMessage = message;

          if (isRedelivered) {
            if (extensions) extensions.activate(message);
            if (ioSpecification) ioSpecification.activate(message);
          }

          executionQ.assertConsumer(onExecutionMessage, {
            exclusive: true,
            consumerTag: '_activity-execution'
          });
          execution = execution || (0, _ActivityExecution.default)(activityApi, context);
          return execution.execute(message);
        }

      case 'run.end':
        {
          if (status === 'end') break;
          counters.taken++;
          status = 'end';

          if (!isRedelivered) {
            broker.publish('run', 'run.leave', content);
            publishEvent('end', content);
          }

          break;
        }

      case 'run.error':
        {
          publishEvent('error', content);
          break;
        }

      case 'run.discarded':
        {
          logger.debug(`<${executionId} (${id})> discarded`);
          counters.discarded++;
          status = 'discarded';
          content.outbound = undefined;

          if (!isRedelivered) {
            broker.publish('run', 'run.leave', content);
          }

          break;
        }

      case 'run.leave':
        {
          const isDiscarded = status === 'discarded';
          status = undefined;
          broker.cancel('_activity-api');
          if (extensions) extensions.deactivate(message);
          if (isRedelivered) break;
          const ignoreOutbound = content.ignoreOutbound;
          let outbound, leaveContent;

          if (!ignoreOutbound) {
            outbound = prepareOutbound(content, isDiscarded);
            leaveContent = { ...content,
              outbound: outbound.slice()
            };
          } else {
            leaveContent = content;
          }

          broker.publish('run', 'run.next', content);
          publishEvent('leave', leaveContent);
          if (!ignoreOutbound) doOutbound(outbound);
          break;
        }

      case 'run.next':
        activate();
        break;
    }

    if (!step) ack();
  }

  function onExecutionMessage(routingKey, message) {
    const content = (0, _messageHelper.cloneContent)({ ...executeMessage.content,
      ...message.content,
      executionId: executeMessage.content.executionId,
      parent: { ...parent
      }
    });
    publishEvent(routingKey, content, message.properties);

    switch (routingKey) {
      case 'execution.outbound.take':
        {
          message.ack();
          const outbound = prepareOutbound(content);
          return doOutbound(outbound);
        }

      case 'execution.stopped':
        {
          message.ack();
          deactivate();
          deactivateRunConsumers();
          broker.cancel('_activity-execution');
          return publishEvent('stop');
        }

      case 'execution.error':
        {
          status = 'error';
          broker.publish('run', 'run.error', content);
          broker.publish('run', 'run.discarded', content);
          break;
        }

      case 'execution.discard':
        status = 'discarded';
        broker.publish('run', 'run.discarded', content);
        break;

      default:
        {
          if (content.outbound && content.outbound.discarded === outboundSequenceFlows.length) {
            status = 'discarded';
            broker.publish('run', 'run.discarded', content);
            break;
          }

          status = 'executed';
          broker.publish('run', 'run.end', content);
        }
    }

    message.ack();

    if (!step && executeMessage) {
      const ackMessage = executeMessage;
      executeMessage = null;
      ackMessage.ack();
    }
  }

  function onApiMessage(routingKey, message) {
    const messageType = message.properties.type;

    switch (messageType) {
      case 'discard':
        {
          discardRun(message);
          break;
        }

      case 'stop':
        {
          onStop(message);
          break;
        }

      case 'shake':
        {
          shakeOutbound(message);
          break;
        }
    }
  }

  function shake() {
    shakeOutbound({
      content: createMessage()
    });
  }

  function shakeOutbound(sourceMessage) {
    const message = (0, _messageHelper.cloneMessage)(sourceMessage);
    message.content.sequence = message.content.sequence || [];
    message.content.sequence.push({
      id,
      type
    });

    if (!outboundSequenceFlows.length) {
      return broker.publish('event', 'activity.shake.end', message.content, {
        persistent: false,
        type: 'shake'
      });
    }

    outboundSequenceFlows.forEach(f => f.shake(message));
  }

  function onStop(message) {
    if (!activityApi.isRunning) return;
    stopped = true;
    consumingRunQ = false;
    broker.cancel('_activity-run');
    broker.cancel('_activity-api');
    broker.cancel('_activity-execution');
    broker.cancel('_run-on-inbound');
    broker.cancel('_format-consumer');
    if (extensions) extensions.deactivate(message || createMessage());
    publishEvent('stop');
  }

  function publishEvent(state, content, messageProperties = {}) {
    if (!state) return;
    if (!content) content = createMessage();
    broker.publish('event', `activity.${state}`, { ...content,
      state
    }, { ...messageProperties,
      type: state,
      mandatory: state === 'error',
      persistent: 'persistent' in messageProperties ? messageProperties.persistent : state !== 'stop'
    });
  }

  function prepareOutbound(fromContent, isDiscarded) {
    if (!outboundSequenceFlows.length) return [];
    const {
      message,
      outbound: evaluatedOutbound = []
    } = fromContent;
    let discardSequence = fromContent.discardSequence;

    if (isDiscarded && !discardSequence && attachedTo && fromContent.inbound && fromContent.inbound[0]) {
      discardSequence = [fromContent.inbound[0].id];
    }

    return outboundSequenceFlows.map(flow => {
      const preparedFlow = getPrepared(flow.id);
      const sequenceId = flow.preFlight(preparedFlow.action);
      preparedFlow.sequenceId = sequenceId;
      return preparedFlow;
    });

    function getPrepared(flowId) {
      let evaluatedFlow = evaluatedOutbound.filter(flow => flow.id === flowId).pop();

      if (!evaluatedFlow) {
        evaluatedFlow = {
          id: flowId,
          action: isDiscarded ? 'discard' : 'take'
        };
        if (message !== undefined) evaluatedFlow.message = message;
      }

      evaluatedFlow.discardSequence = discardSequence;
      if (message !== undefined && !('message' in evaluatedFlow)) evaluatedFlow.message = message;
      return evaluatedFlow;
    }
  }

  function doOutbound(preparedOutbound) {
    if (!preparedOutbound) return;
    outboundSequenceFlows.forEach((flow, idx) => {
      const preparedFlow = preparedOutbound[idx];
      flow[preparedFlow.action](preparedFlow);
    });
  }

  function getActivityById(elementId) {
    return context.getActivityById(elementId);
  }

  function getState() {
    const msg = createMessage();
    return { ...msg,
      status,
      executionId,
      stopped,
      behaviour: { ...behaviour
      },
      counters: { ...counters
      },
      broker: broker.getState(),
      execution: execution && execution.getState()
    };
  }

  function next() {
    if (!step) return;
    if (!stateMessage) return;
    if (status === 'executing') return false;
    if (status === 'formatting') return false;
    const current = stateMessage;
    stateMessage.ack();
    return current;
  }

  function getApi(message) {
    if (execution && !execution.completed) return execution.getApi(message);
    return (0, _Api.ActivityApi)(broker, message || stateMessage);
  }

  function formatRunMessage(formatQ, runMessage, callback) {
    const startFormatMsg = formatQ.get();
    if (!startFormatMsg) return callback(null, runMessage.content);
    const pendingFormats = [];
    const {
      fields,
      content
    } = runMessage;
    const fundamentals = {
      id: content.id,
      type: content.type,
      parent: (0, _messageHelper.cloneParent)(content.parent),
      attachedTo: content.attachedTo,
      executionId: content.executionId,
      isSubProcess: content.isSubProcess,
      isMultiInstance: content.isMultiInstance
    };

    if (content.inbound) {
      fundamentals.inbound = content.inbound.slice();
    }

    if (content.outbound) {
      fundamentals.outbound = content.outbound.slice();
    }

    let formattedContent = (0, _messageHelper.cloneContent)(content);
    const depleted = formatQ.on('depleted', () => {
      if (pendingFormats.length) return;
      depleted.cancel();
      logger.debug(`<${id}> completed formatting ${fields.routingKey}`);
      broker.cancel('_format-consumer');
      callback(null, (0, _shared.filterUndefined)(formattedContent));
    });
    status = 'formatting';
    onFormatMessage(startFormatMsg.fields.routingKey, startFormatMsg);
    formatQ.assertConsumer(onFormatMessage, {
      consumerTag: '_format-consumer',
      prefetch: 100
    });

    function onFormatMessage(routingKey, message) {
      const isStartFormat = message.content.endRoutingKey;

      if (isStartFormat) {
        pendingFormats.push(message);
        return logger.debug(`<${id}> start formatting ${fields.routingKey} message content with formatter ${routingKey}`);
      }

      popFormattingStart(routingKey, message);
      logger.debug(`<${id}> format ${fields.routingKey} message content`);
      formattedContent = { ...formattedContent,
        ...message.content,
        ...fundamentals
      };
      message.ack();
    }

    function popFormattingStart(routingKey) {
      for (let i = 0; i < pendingFormats.length; i++) {
        const pendingFormat = pendingFormats[i];

        if ((0, _smqp.getRoutingKeyPattern)(pendingFormat.content.endRoutingKey).test(routingKey)) {
          logger.debug(`<${id}> completed formatting ${fields.routingKey} message content with formatter ${routingKey}`);
          pendingFormats.splice(i, 1);
          pendingFormat.ack();
          break;
        }
      }
    }
  }
}