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
  if (level === LEVELS.BLOCKED) return false;
  if (level === LEVELS.HIGH_RISK) return false;
  if (taskApproved && level === LEVELS.ASK) return true;
  if (approvedActions.has(actionType)) return true;
  return false;
}

function isTaskApprovable(actionType) {
  const level = ACTION_LEVELS[actionType] || LEVELS.ASK;
  return level === LEVELS.ASK;
}

module.exports = { reset, approveTask, approveAction, isPreApproved, isTaskApprovable };
