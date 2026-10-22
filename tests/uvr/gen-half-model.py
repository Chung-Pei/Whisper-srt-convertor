# tests/uvr/gen-half-model.py — 產生「輸出 = 輸入 × 0.5」的極小 ONNX 替身模型（約 150 位元組）。
# 用途：讓 round13-uvr 的 U-15 以「真實 onnxruntime-web」跑完整的 UVR Worker 流程（真模型 66 MB 且沙盒無法下載）。
# 輸入／輸出形狀與 Kim_Vocal_2 相同：[1, 4, 3072, 256]（float32）。
# 用法：python3 tests/uvr/gen-half-model.py   （需要 pip install onnx；產物 tests/fixtures/uvr/half-model.onnx 已隨套件提供）
import os
import onnx
from onnx import TensorProto, helper

x = helper.make_tensor_value_info('input', TensorProto.FLOAT, [1, 4, 3072, 256])
y = helper.make_tensor_value_info('output', TensorProto.FLOAT, [1, 4, 3072, 256])
half = helper.make_tensor('half', TensorProto.FLOAT, [], [0.5])
graph = helper.make_graph([helper.make_node('Mul', ['input', 'half'], ['output'])], 'half', [x], [y], [half])
model = helper.make_model(graph, opset_imports=[helper.make_opsetid('', 13)])
model.ir_version = 8
onnx.checker.check_model(model)
out = os.path.join(os.path.dirname(__file__), '..', 'fixtures', 'uvr', 'half-model.onnx')
onnx.save(model, out)
print(out, os.path.getsize(out), 'bytes')
