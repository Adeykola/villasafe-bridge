// koffi bindings to Hikvision HCNetSDK. Loads native libs from the first SDK
// folder paths.js finds. If the libraries are missing we start in DEGRADED
// mode: the app still runs, diagnostics work, and any door command returns
// SDK_NOT_LOADED with actionable guidance.
const path = require('path');
const fs = require('fs');
const os = require('os');
const log = require('../../logger');
const { BridgeError } = require('../../utils/errorMap');
const { platformDir, sdkDir, sdkCandidates } = require('../../paths');

function libName() {
  const p = os.platform();
  if (p === 'win32') return 'HCNetSDK.dll';
  if (p === 'darwin') return 'libhcnetsdk.dylib';
  return 'libhcnetsdk.so';
}

let sdk = null;
let loadError = null;
// Missing files can be fixed while the app runs (copy the SDK in, try again);
// a library that was found but failed to load needs an app restart.
const MISSING_FILE_CODES = new Set(['SDK_FOLDER_NOT_FOUND', 'SDK_NOT_LOADED']);

function load() {
  if (sdk) return sdk;
  if (loadError && !MISSING_FILE_CODES.has(loadError.code)) throw loadError;
  loadError = null;

  const root = sdkDir();
  const libPath = path.join(root, libName());

  log.info('Attempting to load HCNetSDK', { root, libPath });

  if (!fs.existsSync(root)) {
    loadError = new BridgeError(
      'SDK_FOLDER_NOT_FOUND',
      `HCNetSDK folder not found. Looked in: ${sdkCandidates().join(' | ')}`,
      `Copy the whole Hikvision SDK folder to ${root}, then try again.`
    );
    throw loadError;
  }

  if (!fs.existsSync(libPath)) {
    loadError = new BridgeError(
      'SDK_NOT_LOADED',
      `HCNetSDK library not found at ${libPath}.`,
      `Copy ${libName()} and every file that ships with it into ${root}, then try again.`
    );
    throw loadError;
  }

  let koffi;

  try {
    koffi = require('koffi');
  } catch (err) {
    loadError = new BridgeError(
      'SDK_LOADER_MISSING',
      'Unable to load koffi.',
      err.stack || err.message
    );
    throw loadError;
  }

  if (os.platform() === 'linux')
    process.env.LD_LIBRARY_PATH = `${root}:${process.env.LD_LIBRARY_PATH || ''}`;

  if (os.platform() === 'darwin')
    process.env.DYLD_LIBRARY_PATH = `${root}:${process.env.DYLD_LIBRARY_PATH || ''}`;

  if (os.platform() === 'win32')
    process.env.PATH = `${root};${process.env.PATH || ''}`;

  let lib;

  try {
    lib = koffi.load(libPath);
  } catch (err) {
    console.error('\n========== HCNetSDK LOAD FAILED ==========');
    console.error('Library:', libPath);
    console.error('Working Directory:', process.cwd());
    console.error('PATH:', process.env.PATH);
    console.error('');
    console.error(err);
    console.error('==========================================\n');

    loadError = new BridgeError(
      'SDK_LOAD_FAILED',
      'Windows failed to load HCNetSDK.',
      err.stack || err.message
    );

    throw loadError;
  }

  log.info('HCNetSDK native library loaded successfully');

  const NET_DVR_USER_LOGIN_INFO = koffi.struct('NET_DVR_USER_LOGIN_INFO', {
    sDeviceAddress: koffi.array('char', 129),
    byUseTransport: 'uint8',
    wPort: 'uint16',
    sUserName: koffi.array('char', 64),
    sPassword: koffi.array('char', 64),
    cbLoginResult: koffi.pointer('void'),
    pUser: koffi.pointer('void'),
    bUseAsynLogin: 'int',
    byProxyType: 'uint8',
    byUseUTCTime: 'uint8',
    byLoginMode: 'uint8',
    byHttps: 'uint8',
    iProxyID: 'int32',
    byVerifyMode: 'uint8',
    byRes3: koffi.array('uint8', 119),
  });

  const NET_DVR_DEVICEINFO_V40 = koffi.struct('NET_DVR_DEVICEINFO_V40', {
    struDeviceV30: koffi.array('uint8', 512),
    bySupportLock: 'uint8',
    byRetryLoginTime: 'uint8',
    byPasswordLevel: 'uint8',
    byProxyType: 'uint8',
    dwSurplusLockTime: 'uint32',
    byCharEncodeType: 'uint8',
    bySupportDev5: 'uint8',
    bySupport: 'uint8',
    byLoginMode: 'uint8',
    dwOEMCode: 'uint32',
    iResidualValidity: 'int32',
    byResidualValidity: 'uint8',
    bySingleStartDTalkChan: 'uint8',
    bySingleDTalkChanNums: 'uint8',
    byPassWordResetLevel: 'uint8',
    bySupportStreamEncrypt: 'uint8',
    byMarketType: 'uint8',
    byRes2: koffi.array('uint8', 238),
  });

  // Payload for NET_DVR_RemoteControl(userId, 16009, ...) on access-control
  // panels. Hikvision's command 16009 expects this exact structure layout.
  const NET_DVR_CONTROL_GATEWAY = koffi.struct('NET_DVR_CONTROL_GATEWAY', {
    dwSize: 'uint32',
    dwGatewayIndex: 'uint32', // 1-based door index (door 1 -> 1)
    byCommand: 'uint8',       // 0=close, 1=open, 2=always-open, 3=always-closed
    byLockType: 'uint8',      // 0
    wLockID: 'uint16',        // 0
    byControlSrc: koffi.array('char', 32), // e.g. "villasafe" for audit trail
    byControlType: 'uint8',   // 1
    byRes3: koffi.array('uint8', 3),
    byPassword: koffi.array('uint8', 16),
    byRes2: koffi.array('uint8', 108),
  });

  const api = {
    NET_DVR_Init: lib.func('int NET_DVR_Init()'),
    NET_DVR_Cleanup: lib.func('int NET_DVR_Cleanup()'),
    NET_DVR_SetConnectTime: lib.func('int NET_DVR_SetConnectTime(uint32, uint32)'),
    NET_DVR_SetReconnect: lib.func('int NET_DVR_SetReconnect(uint32, int)'),
    NET_DVR_Login_V40: lib.func('int NET_DVR_Login_V40(NET_DVR_USER_LOGIN_INFO*, NET_DVR_DEVICEINFO_V40*)'),
    NET_DVR_Logout: lib.func('int NET_DVR_Logout(int)'),
    NET_DVR_GetLastError: lib.func('uint32 NET_DVR_GetLastError()'),
    NET_DVR_ControlGateway: lib.func('int NET_DVR_ControlGateway(int, int32, uint32)'),
    NET_DVR_RemoteControl: lib.func('int NET_DVR_RemoteControl(int, uint32, void*, uint32)'),
  };

  // ---- Access-control alarm (card swipe) + ISAPI passthrough ----
  // Registered defensively: older/trimmed SDK builds may not export them all.
  const optional = (decl, name) => {
    try { return lib.func(decl); }
    catch (e) { log.warn(`SDK symbol unavailable: ${name}`, { error: e.message }); return null; }
  };

  const MSG_CALLBACK = koffi.proto(
    'bool MSG_CALLBACK_V31(int32 lCommand, void *pAlarmer, void *pAlarmInfo, uint32 dwBufLen, void *pUser)'
  );

  const NET_DVR_SETUPALARM_PARAM = koffi.struct('NET_DVR_SETUPALARM_PARAM', {
    dwSize: 'uint32',
    byLevel: 'uint8',
    byAlarmInfoType: 'uint8',
    byRetAlarmTypeV40: 'uint8',
    byRetDevInfoVersion: 'uint8',
    byRetVQDAlarmType: 'uint8',
    byFaceAlarmDetection: 'uint8',
    bySupport: 'uint8',
    byBrokenNetHttp: 'uint8',
    wTaskNo: 'uint16',
    byDeployType: 'uint8',
    bySubScription: 'uint8',
    byRes1: koffi.array('uint8', 2),
    byAlarmTypeURL: 'uint8',
    byCustomCtrl: 'uint8',
  });

  const NET_DVR_XML_CONFIG_INPUT = koffi.struct('NET_DVR_XML_CONFIG_INPUT', {
    dwSize: 'uint32',
    lpRequestUrl: koffi.pointer('void'),
    dwRequestUrlLen: 'uint32',
    lpInBuffer: koffi.pointer('void'),
    dwInBufferSize: 'uint32',
    dwRecvTimeOut: 'uint32',
    byForceEncrpt: 'uint8',
    byNumOfMultiPart: 'uint8',
    byRes: koffi.array('uint8', 30),
  });

  const NET_DVR_XML_CONFIG_OUTPUT = koffi.struct('NET_DVR_XML_CONFIG_OUTPUT', {
    dwSize: 'uint32',
    lpOutBuffer: koffi.pointer('void'),
    dwOutBufferSize: 'uint32',
    dwReturnedXMLSize: 'uint32',
    lpStatusBuffer: koffi.pointer('void'),
    dwStatusSize: 'uint32',
    byRes: koffi.array('uint8', 32),
  });

  api.NET_DVR_SetDVRMessageCallBack_V31 = optional(
    'bool NET_DVR_SetDVRMessageCallBack_V31(MSG_CALLBACK_V31 *fMessageCallBack, void *pUser)',
    'NET_DVR_SetDVRMessageCallBack_V31',
  );
  api.NET_DVR_SetupAlarmChan_V41 = optional(
    'int NET_DVR_SetupAlarmChan_V41(int lUserID, NET_DVR_SETUPALARM_PARAM *lpSetupParam)',
    'NET_DVR_SetupAlarmChan_V41',
  );
  api.NET_DVR_CloseAlarmChan_V30 = optional(
    'bool NET_DVR_CloseAlarmChan_V30(int lAlarmHandle)',
    'NET_DVR_CloseAlarmChan_V30',
  );
  api.NET_DVR_STDXMLConfig = optional(
    'bool NET_DVR_STDXMLConfig(int lUserID, NET_DVR_XML_CONFIG_INPUT *lpInputParam, NET_DVR_XML_CONFIG_OUTPUT *lpOutputParam)',
    'NET_DVR_STDXMLConfig',
  );

  const ok = api.NET_DVR_Init();

  if (!ok) {
    const lastError = api.NET_DVR_GetLastError();

    loadError = new BridgeError(
      'SDK_INIT_FAILED',
      'HCNetSDK initialization failed.',
      `NET_DVR_Init() returned FALSE. Error Code: ${lastError}`
    );

    throw loadError;
  }

  api.NET_DVR_SetConnectTime(5000, 3);
  api.NET_DVR_SetReconnect(10000, 1);

  sdk = {
    koffi,
    lib,
    api,
    structs: {
      NET_DVR_USER_LOGIN_INFO,
      NET_DVR_DEVICEINFO_V40,
      NET_DVR_CONTROL_GATEWAY,
      NET_DVR_SETUPALARM_PARAM,
      NET_DVR_XML_CONFIG_INPUT,
      NET_DVR_XML_CONFIG_OUTPUT,
      MSG_CALLBACK,
    }
  };

  log.info('HCNetSDK initialized successfully');

  return sdk;
}

function status() {
  return {
    loaded: !!sdk,
    lastError: loadError ? loadError.toJSON() : null,
    platform: platformDir(),
    libraryName: libName(),
    folder: sdkDir(),
  };
}

function shutdown() {
  if (sdk) {
    try { sdk.api.NET_DVR_Cleanup(); } catch { /* noop */ }
    sdk = null;
  }
}

module.exports = { load, status, shutdown };