import { useEffect, useRef } from 'react'
import { useMap } from 'react-leaflet'
import L from 'leaflet'
import type { GeographicRegionBounds } from './decimate'

const BOX_SELECT_PANE = 'boxSelectPane'
const MIN_DRAG_PX = 8

export { BOX_SELECT_PANE }

function boundsFromLatLngPair(
  a: L.LatLng,
  b: L.LatLng,
): GeographicRegionBounds {
  return {
    south: Math.min(a.lat, b.lat),
    north: Math.max(a.lat, b.lat),
    west: Math.min(a.lng, b.lng),
    east: Math.max(a.lng, b.lng),
  }
}

type Props = {
  active: boolean
  /** Geographic box only (same as `L.LatLngBounds`); counts are derived in the app. */
  onComplete: (bounds: GeographicRegionBounds) => void
}

/**
 * Drag rectangle on the map using Leaflet mouse events + L.rectangle.
 * While {@link active}, map dragging is disabled; it is re-enabled after a completed box or on cleanup.
 */
export default function BoxSelectInteraction({
  active,
  onComplete,
}: Props) {
  const map = useMap()
  const previewRef = useRef<L.Rectangle | null>(null)
  const dragRef = useRef<{ start: L.LatLng } | null>(null)

  useEffect(() => {
    if (!active) return

    const container = map.getContainer()
    map.dragging.disable()
    map.doubleClickZoom.disable()
    container.classList.add('map-box-select-active')

    const removePreview = () => {
      previewRef.current?.remove()
      previewRef.current = null
    }

    const getPreview = () => {
      if (!previewRef.current) {
        previewRef.current = L.rectangle(
          L.latLngBounds([0, 0], [0, 0]),
          {
            pane: BOX_SELECT_PANE,
            color: '#b85d86',
            weight: 2,
            dashArray: '6 4',
            fillColor: '#d67fa3',
            fillOpacity: 0.12,
            interactive: false,
          },
        ).addTo(map)
      }
      return previewRef.current
    }

    const onDocMove = (ev: MouseEvent) => {
      if (!dragRef.current) return
      const latlng = map.mouseEventToLatLng(ev)
      getPreview().setBounds(
        L.latLngBounds(dragRef.current.start, latlng),
      )
    }

    const onDocUp = (ev: MouseEvent) => {
      document.removeEventListener('mousemove', onDocMove)
      document.removeEventListener('mouseup', onDocUp)

      const start = dragRef.current?.start
      dragRef.current = null
      removePreview()

      if (!start) return

      const end = map.mouseEventToLatLng(ev)
      const bounds = boundsFromLatLngPair(start, end)
      const c1 = map.latLngToContainerPoint(L.latLng(bounds.north, bounds.west))
      const c2 = map.latLngToContainerPoint(L.latLng(bounds.south, bounds.east))
      if (Math.hypot(c2.x - c1.x, c2.y - c1.y) < MIN_DRAG_PX) return

      map.dragging.enable()
      map.doubleClickZoom.enable()
      container.classList.remove('map-box-select-active')
      onComplete(bounds)
    }

    const onMapMouseDown = (e: L.LeafletMouseEvent) => {
      const me = e.originalEvent as MouseEvent
      if (me.button !== 0) return
      dragRef.current = { start: e.latlng }
      getPreview().setBounds(L.latLngBounds(e.latlng, e.latlng))
      document.addEventListener('mousemove', onDocMove)
      document.addEventListener('mouseup', onDocUp)
    }

    map.on('mousedown', onMapMouseDown)

    return () => {
      document.removeEventListener('mousemove', onDocMove)
      document.removeEventListener('mouseup', onDocUp)
      map.off('mousedown', onMapMouseDown)
      removePreview()
      dragRef.current = null
      map.dragging.enable()
      map.doubleClickZoom.enable()
      container.classList.remove('map-box-select-active')
    }
  }, [active, map, onComplete])

  return null
}
