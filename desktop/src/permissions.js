const LEVELS = {
  SAFE: 1,
  ASK: 2,
  HIGH_RISK: 3,
  BLOCKED: 4,
};

const ACTION_LEVELS = {
  open_app: LEVELS.SAFE,
  open_url: LEVELS.SAFE,
  web_search: LEVELS.SAFE,
  read_screen: LEVELS.SAFE,
  calculator: LEVELS.SAFE,
  current_time: LEVELS.SAFE,
  weather: LEVELS.SAFE,
  file_create_workspace: LEVELS.SAFE,
  file_list_workspace: LEVELS.SAFE,
  file_read_workspace: LEVELS.SAFE,
  memory_search: LEVELS.SAFE,
  memory_write: LEVELS.SAFE,
  screen_info: LEVELS.SAFE,
  mouse_move: LEVELS.SAFE,
  mouse_scroll: LEVELS.SAFE,
  clipboard_read: LEVELS.SAFE,
  window_list: LEVELS.SAFE,
  window_focus: LEVELS.SAFE,
  window_minimize: LEVELS.SAFE,
  window_maximize: LEVELS.SAFE,

  send_email: LEVELS.ASK,
  send_message: LEVELS.ASK,
  create_event: LEVELS.ASK,
  file_write_outside: LEVELS.ASK,
  file_read_outside: LEVELS.ASK,
  change_settings: LEVELS.ASK,
  upload_file: LEVELS.ASK,
  browser_type: LEVELS.ASK,
  browser_click: LEVELS.ASK,
  keyboard_type: LEVELS.ASK,
  keyboard_combo: LEVELS.ASK,
  mouse_click: LEVELS.ASK,
  mouse_drag: LEVELS.ASK,
  clipboard_write: LEVELS.ASK,
  window_resize: LEVELS.ASK,
  window_close: LEVELS.ASK,

  delete_file: LEVELS.HIGH_RISK,
  delete_data: LEVELS.HIGH_RISK,
  install_software: LEVELS.HIGH_RISK,
  change_system_settings: LEVELS.HIGH_RISK,
  change_permissions: LEVELS.HIGH_RISK,
  run_shell_command: LEVELS.HIGH_RISK,

  purchase: LEVELS.BLOCKED,
  payment: LEVELS.BLOCKED,
  enter_credit_card: LEVELS.BLOCKED,
  cancel_subscription: LEVELS.BLOCKED,
  change_password: LEVELS.BLOCKED,
  bypass_security: LEVELS.BLOCKED,
  disable_antivirus: LEVELS.BLOCKED,
  disable_firewall: LEVELS.BLOCKED,
};

function getLevel(action) {
  return ACTION_LEVELS[action] || LEVELS.ASK;
}

function isAllowed(action, mode) {
  const level = getLevel(action);
  if (level === LEVELS.BLOCKED) return { allowed: false, reason: "blocked", needsApproval: false };
  // Safe mode is read-only: anything above SAFE is refused outright, with no
  // approval path. Otherwise "safe" would be indistinguishable from "assistant".
  if (mode === "safe" && level > LEVELS.SAFE) return { allowed: false, reason: "safe_mode", needsApproval: false };
  if (level === LEVELS.SAFE) return { allowed: true, reason: "safe", needsApproval: false };
  return { allowed: false, reason: "needs_approval", needsApproval: true };
}

function levelLabel(level) {
  return { 1: "SAFE", 2: "ASK", 3: "HIGH_RISK", 4: "BLOCKED" }[level] || "UNKNOWN";
}

function isTaskApprovable(action) {
  return getLevel(action) === LEVELS.ASK;
}

module.exports = { LEVELS, ACTION_LEVELS, getLevel, isAllowed, levelLabel, isTaskApprovable };
