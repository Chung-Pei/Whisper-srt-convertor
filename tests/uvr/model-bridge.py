"""U-14（選用）用的橋接：以本機 python onnxruntime 執行真實的 Kim_Vocal_2.onnx，讓瀏覽器測試把 ort-web 換成對這個伺服器的 fetch。
驗證範圍：真實模型＋真實 JS DSP／Worker 流程；唯一沒被驗證的是 onnxruntime-web 本身（沙盒取不到）。
用法：python3 tests/uvr/model-bridge.py <Kim_Vocal_2.onnx> <port>
  GET  /ping → ok
  POST /run  body＝float32 [1,4,3072,256]（小端）→ 回應同形的 float32"""
import os, sys, traceback
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
import numpy as np
import onnxruntime as ort

model_path, port = sys.argv[1], int(sys.argv[2])
opts = ort.SessionOptions()
opts.intra_op_num_threads = 2
sess = ort.InferenceSession(model_path, opts, providers=['CPUExecutionProvider'])
in_name = sess.get_inputs()[0].name
SHAPE = (1, 4, 3072, 256)


class H(BaseHTTPRequestHandler):
    def _send(self, code, body=b'', ctype='application/octet-stream'):
        self.send_response(code)
        self.send_header('Access-Control-Allow-Origin', '*')
        self.send_header('Access-Control-Allow-Methods', 'GET, POST, OPTIONS')
        self.send_header('Access-Control-Allow-Headers', '*')
        self.send_header('Content-Type', ctype)
        self.send_header('Content-Length', str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def do_OPTIONS(self):
        self._send(204)

    def do_GET(self):
        self._send(200, b'ok', 'text/plain')

    def do_POST(self):
        try:
            n = int(self.headers.get('Content-Length', 0))
            x = np.frombuffer(self.rfile.read(n), dtype='<f4')
            if x.size != int(np.prod(SHAPE)):
                return self._send(400, ('bad size %d' % x.size).encode(), 'text/plain')
            y = sess.run(None, {in_name: x.reshape(SHAPE)})[0]
            self._send(200, np.ascontiguousarray(y, dtype='<f4').tobytes())
        except Exception:
            traceback.print_exc()
            self._send(500, traceback.format_exc().encode(), 'text/plain')

    def log_message(self, fmt, *a):
        if os.environ.get('UVR_BRIDGE_LOG'):
            sys.stderr.write('[bridge] ' + (fmt % a) + '\n')


ThreadingHTTPServer(('127.0.0.1', port), H).serve_forever()
