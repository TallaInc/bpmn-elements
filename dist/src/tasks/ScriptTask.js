"use strict";

Object.defineProperty(exports, "__esModule", {
  value: true
});
exports.default = ScriptTask;
exports.ScriptTaskBehaviour = ScriptTaskBehaviour;

var _Activity = _interopRequireDefault(require("../activity/Activity"));

var _ExecutionScope = _interopRequireDefault(require("../activity/ExecutionScope"));

var _Errors = require("../error/Errors");

var _messageHelper = require("../messageHelper");

function _interopRequireDefault(obj) { return obj && obj.__esModule ? obj : { default: obj }; }

function ScriptTask(activityDef, context) {
  return (0, _Activity.default)(ScriptTaskBehaviour, activityDef, context);
}

function ScriptTaskBehaviour(activity) {
  const {
    id,
    type,
    behaviour,
    broker,
    logger,
    environment,
    emitFatal
  } = activity;
  const {
    scriptFormat,
    script: scriptBody
  } = activity.behaviour;
  const loopCharacteristics = behaviour.loopCharacteristics && behaviour.loopCharacteristics.Behaviour(activity, behaviour.loopCharacteristics);
  environment.registerScript(activity);
  const source = {
    id,
    type,
    loopCharacteristics,
    execute
  };
  return source;

  function execute(executeMessage) {
    const content = (0, _messageHelper.cloneContent)(executeMessage.content);

    if (loopCharacteristics && content.isRootScope) {
      return loopCharacteristics.execute(executeMessage);
    }

    if (!scriptBody) return broker.publish('execution', 'execute.completed', content);
    const script = environment.getScript(scriptFormat, activity);

    if (!script) {
      return emitFatal(new _Errors.ActivityError(`Script format ${scriptFormat} is unsupported or was not registered for <${activity.id}>`, executeMessage), content);
    }

    return script.execute((0, _ExecutionScope.default)(activity, executeMessage), scriptCallback);

    function scriptCallback(err, output) {
      if (err) {
        logger.error(`<${content.executionId} (${id})>`, err);
        return broker.publish('execution', 'execute.error', { ...content,
          error: new _Errors.ActivityError(err.message, executeMessage, err)
        }, {
          mandatory: true
        });
      }

      return broker.publish('execution', 'execute.completed', { ...content,
        output
      });
    }
  }
}