FROM ps5library-build:0.43
RUN apt-get update && apt-get install -y --no-install-recommends git zlib1g-dev && rm -rf /var/lib/apt/lists/*
COPY docker/json-c-0.19-release.patch /tmp/json-c-0.19-release.patch
RUN git clone https://github.com/json-c/json-c.git /tmp/json-c \
 && git -C /tmp/json-c checkout aa716cd8d663c976b99b0f30f102ee1d8ef63146 \
 && git -C /tmp/json-c apply /tmp/json-c-0.19-release.patch \
 && prospero-cmake -S /tmp/json-c -B /tmp/json-c-build \
      -DCMAKE_BUILD_TYPE=Release -DBUILD_SHARED_LIBS=OFF -DBUILD_TESTING=OFF \
      -DDISABLE_WERROR=ON -DNEWLOCALE_NEEDS_FREELOCALE=ON \
 && cmake --build /tmp/json-c-build -j2 \
 && cp /tmp/json-c-build/libjson-c.a /opt/ps5-payload-sdk/target/user/homebrew/lib/libjson-c.a \
 && rm -rf /tmp/json-c /tmp/json-c-build /tmp/json-c-0.19-release.patch
