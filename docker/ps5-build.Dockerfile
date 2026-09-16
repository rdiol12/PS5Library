FROM ubuntu:24.04
RUN apt-get update && DEBIAN_FRONTEND=noninteractive apt-get install -y --no-install-recommends clang-18 lld-18 llvm-18 cmake make curl unzip ca-certificates pkg-config libsdl2-dev libsdl2-image-dev libsdl2-ttf-dev libcurl4-openssl-dev libjson-c-dev libssl-dev fonts-dejavu-core python3 && rm -rf /var/lib/apt/lists/*
WORKDIR /opt
RUN curl -fL --retry 3 https://github.com/ps5-payload-dev/sdk/releases/download/v0.43/ps5-payload-sdk.zip -o sdk.zip \
    && echo 'a9cc9929f21b2b2c5d5b309f3bab4997067c45281c0622cf4838b1aecba66fcb  sdk.zip' | sha256sum -c - \
    && unzip -q sdk.zip && rm sdk.zip
RUN curl -fL --retry 3 https://github.com/ps5-payload-dev/pacbrew-repo/releases/download/v0.40.2/ps5-payload-dev.tar.gz -o ports.tar.gz \
    && echo 'a85f65de418a8e6a898c6c3e3c870d50fff7618a200e4dd59ea9692af6ecec4d  ports.tar.gz' | sha256sum -c - \
    && tar -xzf ports.tar.gz && rm ports.tar.gz
RUN cp -an /opt/opt/ps5-payload-sdk/target/. /opt/ps5-payload-sdk/target/ && rm -rf /opt/opt
ENV PS5_PAYLOAD_SDK=/opt/ps5-payload-sdk
ENV PATH="/opt/ps5-payload-sdk/bin:${PATH}"
WORKDIR /workspace
RUN apt-get update && DEBIAN_FRONTEND=noninteractive apt-get install -y --no-install-recommends ffmpeg libavcodec-dev libavformat-dev libavutil-dev libswresample-dev libswscale-dev && rm -rf /var/lib/apt/lists/*
