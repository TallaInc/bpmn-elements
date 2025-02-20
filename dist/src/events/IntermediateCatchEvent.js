"use strict";

Object.defineProperty(exports, "__esModule", {
  value: true
});
exports.default = IntermediateCatchEvent;
exports.IntermediateCatchEventBehaviour = IntermediateCatchEventBehaviour;

var _Activity = _interopRequireDefault(require("../activity/Activity"));

var _EventDefinitionExecution = _interopRequireDefault(require("../eventDefinitions/EventDefinitionExecution"));

var _messageHelper = require("../messageHelper");

function _interopRequireDefault(obj) { return obj && obj.__esModule ? obj : { default: obj }; }

function IntermediateCatchEvent(activityDef, context) {
  return (0, _Activity.default)(IntermediateCatchEventBehaviour, activityDef, context);
}

function IntermediateCatchEventBehaviour(activity) {
  const {
    id,
    type,
    broker,
    eventDefinitions
  } = activity;
  const eventDefinitionExecution = eventDefinitions && (0, _EventDefinitionExecution.default)(activity, eventDefinitions);
  const source = {
    id,
    type,
    execute
  };
  return source;

  function execute(executeMessage) {
    if (eventDefinitionExecution) {
      return eventDefinitionExecution.execute(executeMessage);
    }

    const messageContent = (0, _messageHelper.cloneContent)(executeMessage.content);
    const {
      executionId
    } = messageContent;
    broker.subscribeTmp('api', `activity.#.${executionId}`, onApiMessage, {
      noAck: true,
      consumerTag: `_api-${executionId}`
    });
    return broker.publish('event', 'activity.wait', (0, _messageHelper.cloneContent)(messageContent));

    function onApiMessage(routingKey, message) {
      const messageType = message.properties.type;

      switch (messageType) {
        case 'message':
        case 'signal':
          {
            return complete(message.content.message);
          }

        case 'discard':
          {
            stop();
            return broker.publish('execution', 'execute.discard', { ...messageContent
            });
          }

        case 'stop':
          {
            return stop();
          }
      }
    }

    function complete(output) {
      stop();
      return broker.publish('execution', 'execute.completed', { ...messageContent,
        output
      });
    }

    function stop() {
      broker.cancel(`_api-${executionId}`);
    }
  }
}