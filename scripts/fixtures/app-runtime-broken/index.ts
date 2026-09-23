/**
 * 「App Runtime 启动失败」夹具。
 *
 * 它不实现任何协议，只复用真实插件（plugins/app-runtime）的入口 —— 差别全在
 * plugin.json：config.modules 指向一个不存在的模块，于是
 * Application.start() 会抛错，插件的 onInit 跟着抛错。
 *
 * 刻意不在这里复制一份「启动逻辑」：如果这里是一份副本，那么它证明的只是
 * 「这份副本会在坏配置下失败」，而不是真实插件会失败 —— 那就没有测试价值了。
 */
import '../../../plugins/app-runtime/index.ts';