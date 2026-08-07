import lottie, { type AnimationItem } from 'lottie-web';
import { useEffect, useRef, useState } from 'react';

/**
 * Стікер, який рухається сам.
 *
 * Растровий стікер — мертва картинка, і весь рух доводиться домальовувати
 * зовні: поява, дрейф, удар, салют. Lottie несе власну анімацію всередині
 * файлу, тож предмет живе сам, а наші ефекти лягають зверху приправою.
 *
 * ЧОМУ БЕЗ АВТОПРОГРАВАННЯ. Плеєр не грає сам: кадр задається ззовні з
 * часу ролика. Інакше анімація жила б за власним годинником — при паузі
 * крутилась би далі, при перемотці показувала б випадкове місце, а в
 * рендері (де кадри знімаються не в реальному часі) розповзлась би
 * зовсім. Це той самий контракт, що й у HyperFrames: програвач лише
 * перемотують.
 */
export function LottieSticker({ src, age }: { src: string; age: number }) {
  const box = useRef<HTMLDivElement>(null);
  const anim = useRef<AnimationItem | null>(null);
  const [ready, setReady] = useState(0);

  useEffect(() => {
    const node = box.current;
    if (!node) return undefined;
    const item = lottie.loadAnimation({
      container: node,
      renderer: 'svg',
      loop: false,
      autoplay: false,
      path: src,
    });
    anim.current = item;
    // Тривалість відома лише після завантаження JSON, а до неї перемотка
    // безглузда: goToAndStop на нулі кадрів мовчки нічого не робить.
    const onLoad = () => setReady((n) => n + 1);
    item.addEventListener('DOMLoaded', onLoad);
    return () => {
      item.removeEventListener('DOMLoaded', onLoad);
      item.destroy();
      anim.current = null;
    };
  }, [src]);

  useEffect(() => {
    const item = anim.current;
    if (!item || ready === 0) return;
    const frames = item.getDuration(true);
    if (!frames) return;
    const fps = item.frameRate || 30;
    // Цикл, а не одноразовий програш: предмет має жити весь час, поки
    // висить у кадрі. Модуль рахується від віку стікера, тому та сама
    // секунда ролика завжди дає той самий кадр.
    const frame = (((age * fps) % frames) + frames) % frames;
    item.goToAndStop(frame, true);
  }, [age, ready]);

  return <div ref={box} className="post-ws__sticker-lottie" aria-hidden />;
}
