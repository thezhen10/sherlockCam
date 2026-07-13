export { CameraScanner } from './core/CameraScanner';
export { Camera } from './core/Camera';
export { FrameGrabber } from './core/FrameGrabber';
export type { FrameGrabberOptions } from './core/FrameGrabber';

export type {
  CameraScannerOptions,
  Detector,
  DetectorActivityEvent,
  DetectorFrame,
  PreprocessingOptions,
  RegionOfInterest,
  ScanResult,
  OcrScanResult,
  BarcodeScanResult,
  CharacterScanResult,
  ScannerState,
  ScannerEventMap,
} from './core/types';

export { TesseractOcrDetector } from './detectors/ocr/TesseractOcrDetector';
export type { TesseractOcrDetectorOptions } from './detectors/ocr/TesseractOcrDetector';

export { TensorflowCharacterDetector } from './detectors/character/TensorflowCharacterDetector';
export type {
  CharacterNormalizeMode,
  TensorflowCharacterDetectorOptions,
} from './detectors/character/TensorflowCharacterDetector';

export { ZxingBarcodeDetector } from './detectors/barcode/ZxingBarcodeDetector';
export type { ZxingBarcodeDetectorOptions } from './detectors/barcode/ZxingBarcodeDetector';
