FROM python:3.12-slim
WORKDIR /app
COPY requirements.txt .
RUN pip install --no-cache-dir -r requirements.txt
COPY server.py .
# 模型（聲紋 ONNX、faster-whisper）首次啟動時下載到 /models，掛載 volume 即可保留
ENV DIARIZE_HOST=0.0.0.0 \
    SPEAKER_MODEL_PATH=/models/voxceleb_resnet34_LM.onnx \
    HF_HOME=/models/hf
VOLUME /models
EXPOSE 8788
CMD ["python", "server.py"]
