// KeyboardEvent.code → Windows VK（美式布局物理键位）
export const CODE_VK = {
  Escape: 0x1B, Backquote: 0xC0, Minus: 0xBD, Equal: 0xBB, Backspace: 0x08, Tab: 0x09,
  BracketLeft: 0xDB, BracketRight: 0xDD, Backslash: 0xDC, Semicolon: 0xBA, Quote: 0xDE,
  Enter: 0x0D, Comma: 0xBC, Period: 0xBE, Slash: 0xBF, Space: 0x20, CapsLock: 0x14,
  Insert: 0x2D, Delete: 0x2E, Home: 0x24, End: 0x23, PageUp: 0x21, PageDown: 0x22,
  PrintScreen: 0x2C, ScrollLock: 0x91, Pause: 0x13,
  ArrowLeft: 0x25, ArrowUp: 0x26, ArrowRight: 0x27, ArrowDown: 0x28,
  ShiftLeft: 0xA0, ShiftRight: 0xA1, ControlLeft: 0xA2, ControlRight: 0xA3,
  AltLeft: 0xA4, AltRight: 0xA5, MetaLeft: 0x5B, MetaRight: 0x5C, ContextMenu: 0x5D,
  NumpadDivide: 0x6F, NumpadMultiply: 0x6A, NumpadSubtract: 0x6D, NumpadAdd: 0x6B,
  NumpadEnter: 0x0D, NumpadDecimal: 0x6E,
  Numpad0: 0x60, Numpad1: 0x61, Numpad2: 0x62, Numpad3: 0x63, Numpad4: 0x64,
  Numpad5: 0x65, Numpad6: 0x66, Numpad7: 0x67, Numpad8: 0x68, Numpad9: 0x69,
  NumLock: 0x90,
};
for (let i = 0; i < 10; i++) CODE_VK['Digit' + i] = 0x30 + i;
for (let i = 0; i < 26; i++) CODE_VK['Key' + String.fromCharCode(65 + i)] = 0x41 + i;
for (let i = 0; i < 12; i++) CODE_VK['F' + (i + 1)] = 0x70 + i;
for (let i = 13; i <= 24; i++) CODE_VK['F' + i] = 0x70 + i - 1;
