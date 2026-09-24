/**
 * GenVideo（ai-genvideo.com）上 Seedance 2.5 的**上游契约声明**（单一来源）。
 *
 * 为什么单独一份：这份声明同时被两处消费 ——
 *   1. `scripts/set-video-model-capability.mjs` 把它写进库（模型能力 + 厂商 extraJson）；
 *   2. `tests/video-create-contract.test.ts` 用它断言"发出去的字段名/固定值/六种画幅"。
 * 两处各抄一份必然会漂移（改了一处忘另一处，症状是线上参数静默失效），所以放这里。
 *
 * 依据：用户提供的上游文档（Base https://ai-genvideo.com/v1）：
 *   - POST /videos/generations：prompt / mode(2.0 默认, 2.5) / ratio(六种) /
 *     durationSeconds(2.0: 5|10|15, 2.5: 固定 30) / images(≤10, [{url}])
 *   - GET /tasks/{id}；GET /tasks/output-url/{id}（换发过期地址）
 */

export const VIDEO_MODEL_ID = 'm-sceneflow-genvideo-2-5-0'
export const VIDEO_PROVIDER_ID = 'p-sceneflow-genvideo-2-5'

/** 上游支持的六种画幅（冒号形式，就是发出去的 key） */
export const UPSTREAM_VIDEO_RATIOS = [
  { label: '21:9 宽幅', key: '21:9' },
  { label: '16:9 横版', key: '16:9' },
  { label: '4:3', key: '4:3' },
  { label: '1:1 方形', key: '1:1' },
  { label: '3:4', key: '3:4' },
  { label: '9:16 竖版', key: '9:16' },
]

/**
 * 模型能力声明（capabilityJson）。
 * `params.*` 给前端出控件（比例 / 时长 / 分辨率），`createParams` 给服务端拼上游请求体：
 *   - mode: 必填，2.5 是固定 30 秒档；不传上游按 2.0 出 5/10 秒的片子
 *   - durationField: 上游字段名是 durationSeconds（我们内部叫 duration，不映射就被忽略）
 *   - imagesField: 上游要吃 [{url}]（我们前端传的是 image_urls: [string]）
 */
export const VIDEO_MODEL_CAPABILITY = {
  params: {
    ratio: { options: UPSTREAM_VIDEO_RATIOS, default: '16:9' },
    // 2.5 只有 30 秒这一个档位：用户选了别的（老节点数据里的 5 秒）由服务端纠到 30
    duration: { options: [{ label: '30 秒', key: '30' }], default: '30' },
    resolution: {
      options: [
        { label: '720P', key: '720p' },
        { label: '1080P', key: '1080p' },
      ],
      default: '720p',
    },
  },
  createParams: {
    mode: '2.5',
    durationField: 'durationSeconds',
    imagesField: 'images',
  },
}

/** 模型默认参数（前端新建节点时的默认档位）。视频按条计费，档位不影响价格。 */
export const VIDEO_MODEL_DEFAULT_PARAMS = {
  ratio: '16:9',
  duration: 30,
  resolution: '720p',
}

/**
 * 厂商 extraJson 补齐：除了已有的 dialect / 查询路径，还要显式声明**换发成品地址**的路径。
 * 产物是带时间签名的 CDN 地址，过期后 403，只能向它换一份新的。
 */
export const VIDEO_PROVIDER_EXTRA_JSON = {
  videoDialect: 'task-generic',
  videoStatusPath: '/tasks/{id}',
  videoOutputUrlPath: '/tasks/output-url/{id}',
}
