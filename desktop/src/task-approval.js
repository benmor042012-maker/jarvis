const { LEVELS, ACTION_LEVELS } = require("./permissions");

let taskApproved = false;
let approvedActions = new Set();

function reset() {
  taskApproved = false;
  approvedActions = new Set();
}

function approveTask() {
  taskApproved = true;
}

function approveAction(actionType) {
  approvedActions.add(actionType);
}

function isPreApproved(actionType) {
  const level = ACTION_LEVELS[actionType] || LEVELS.ASK;
  // CONFIRM and above are never carried over from an earlier approval — not by
  // a task-wide approval, and not by an earlier approval of the same action.
  // Every message, every deletion, every shell command is confirmed on its own.
  if (level >= LEVELS.CONFIRM) return false;
  if (taskApproved && level === LEVELS.ASK) return true;
  if (approvedActions.has(actionType)) return true;
  return false;
}

function isTaskApprovable(actionType) {
  const level = ACTION_LEVELS[actionType] || LEVELS.ASK;
  return level === LEVELS.ASK;
}

module.exports = { reset, approveTask, approveAction, isPreApproved, isTaskApprovable };
