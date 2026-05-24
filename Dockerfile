FROM mcr.microsoft.com/playwright:v1.60.0-noble-arm64

RUN apt-get update && apt-get install -y --no-install-recommends \
    cmake \
    g++ \
    make \
    xz-utils \
  && rm -rf /var/lib/apt/lists/*

WORKDIR /var/task
COPY package.json package-lock.json* yarn.lock* ./
RUN PLAYWRIGHT_SKIP_BROWSER_DOWNLOAD=1 npm install

COPY tsconfig.json ./
COPY src ./src
RUN npx tsc

ENTRYPOINT ["/var/task/node_modules/.bin/aws-lambda-ric"]
CMD ["dist/lambda.handler"]
